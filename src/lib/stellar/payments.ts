import "server-only";
import {
  Asset,
  BASE_FEE,
  Horizon,
  Memo,
  Operation,
  StrKey,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { Keypair } from "@stellar/stellar-sdk";
import { stellarNetwork } from "../config/stellar";
import { StellarIntegrationError } from "./server";

/**
 * Classic XLM transfers over Horizon.
 *
 * Soroban is the wrong tool for a plain payment between two accounts: it costs
 * more, needs a contract invocation and gains nothing. These are ordinary
 * Stellar payment operations, which is what an external wallet can sign and
 * what a block explorer shows as a normal transfer.
 */

/** 2 base reserves (account + 1 trustline) plus fee headroom. */
export const BASE_RESERVE_XLM = 1;
export const FEE_HEADROOM_XLM = 0.5;
export const MAX_MEMO_LENGTH = 28;

export function horizonServer(): Horizon.Server {
  return new Horizon.Server(stellarNetwork().horizonUrl);
}

export function isValidStellarAddress(address: string): boolean {
  return StrKey.isValidEd25519PublicKey(address);
}

export interface AccountSnapshot {
  address: string;
  exists: boolean;
  xlm: string;
  /** Balance that can be sent without dipping into the minimum reserve. */
  spendableXlm: string;
  reserveXlm: string;
  subentries: number;
}

function round7(value: number): string {
  return value.toFixed(7).replace(/0+$/, "").replace(/\.$/, "");
}

export async function accountSnapshot(address: string): Promise<AccountSnapshot> {
  const server = horizonServer();
  try {
    const account = await server.loadAccount(address);
    const native = account.balances.find((balance) => balance.asset_type === "native");
    const xlm = native ? Number(native.balance) : 0;
    const subentries = account.subentry_count ?? 0;
    const reserve = (2 + subentries) * 0.5;
    const spendable = Math.max(xlm - reserve - FEE_HEADROOM_XLM, 0);
    return {
      address,
      exists: true,
      xlm: round7(xlm),
      spendableXlm: round7(spendable),
      reserveXlm: round7(reserve),
      subentries,
    };
  } catch (error) {
    if (isNotFound(error)) {
      return { address, exists: false, xlm: "0", spendableXlm: "0", reserveXlm: "0", subentries: 0 };
    }
    throw new StellarIntegrationError(
      "Could not reach Stellar to read that balance. Please try again.",
      "balance_unavailable",
      error,
    );
  }
}

function isNotFound(error: unknown): boolean {
  const status = (error as { response?: { status?: number } })?.response?.status;
  if (status === 404) return true;
  const name = (error as { name?: string })?.name;
  return name === "NotFoundError";
}

/** Builds an unsigned native-XLM payment. The caller decides who signs it. */
export async function buildPayment(input: {
  source: string;
  destination: string;
  amountXlm: string;
  memo?: string | null;
}): Promise<{ xdr: string; sequence: string }> {
  const net = stellarNetwork();
  const server = horizonServer();
  let account: Horizon.AccountResponse;
  try {
    account = await server.loadAccount(input.source);
  } catch (error) {
    if (isNotFound(error)) {
      throw new StellarIntegrationError(
        "This wallet has no funds on Testnet yet. Deposit first, then try again.",
        "source_not_funded",
        error,
      );
    }
    throw new StellarIntegrationError(
      "Could not reach Stellar to prepare the transfer. Please try again.",
      "build_failed",
      error,
    );
  }

  const memo = input.memo?.trim() ? Memo.text(input.memo.trim().slice(0, MAX_MEMO_LENGTH)) : undefined;
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: net.networkPassphrase,
    ...(memo ? { memo } : {}),
  })
    .addOperation(
      Operation.payment({
        destination: input.destination,
        asset: Asset.native(),
        amount: input.amountXlm,
      }),
    )
    .setTimeout(180)
    .build();

  return { xdr: transaction.toXDR(), sequence: account.sequence };
}

export function signPaymentXdr(xdrBase64: string, keypair: Keypair): string {
  const transaction = TransactionBuilder.fromXDR(xdrBase64, stellarNetwork().networkPassphrase) as Transaction;
  transaction.sign(keypair);
  return transaction.toXDR();
}

export interface SubmittedPayment {
  hash: string;
  ledger: number | null;
}

export async function submitPaymentXdr(xdrBase64: string): Promise<SubmittedPayment> {
  const server = horizonServer();
  const transaction = TransactionBuilder.fromXDR(xdrBase64, stellarNetwork().networkPassphrase) as Transaction;
  try {
    const response = await server.submitTransaction(transaction);
    return { hash: response.hash, ledger: response.ledger ?? null };
  } catch (error) {
    const detail = (error as { response?: { data?: { extras?: { result_codes?: unknown } } } })?.response?.data
      ?.extras?.result_codes;
    const codes = detail ? JSON.stringify(detail) : null;
    console.error("[chain-duel] Horizon rejected a payment:", codes ?? (error instanceof Error ? error.message : error));
    if (/op_underfunded|op_low_reserve|insufficient/i.test(codes ?? "")) {
      throw new StellarIntegrationError(
        "That wallet does not have enough XLM for this transfer once the reserve is kept.",
        "insufficient_balance",
        error,
      );
    }
    throw new StellarIntegrationError("Stellar rejected the transfer. Nothing was sent.", "submit_failed", error);
  }
}

/** Unfunded Testnet accounts can be created with Friendbot. */
export async function fundTestnetAccount(address: string): Promise<{ hash: string | null; ledger: number | null }> {
  const net = stellarNetwork();
  if (!net.friendbotUrl) {
    throw new StellarIntegrationError("Friendbot is only available on Testnet.", "no_friendbot", 400);
  }
  const response = await fetch(`${net.friendbotUrl}/?addr=${encodeURIComponent(address)}`, { method: "GET" });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.error("[chain-duel] friendbot failed:", response.status, body.slice(0, 300));
    throw new StellarIntegrationError(
      response.status === 400
        ? "That wallet already has a Testnet balance."
        : "The Testnet faucet is busy. Please try again.",
      "faucet_failed",
      response.status,
    );
  }
  // Friendbot returns the funding transaction; keep its hash for the receipt.
  const payload = (await response.json().catch(() => null)) as { hash?: string; ledger?: number } | null;
  return { hash: payload?.hash ?? null, ledger: payload?.ledger ?? null };
}
