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
import { STELLAR_MAINNET_USDC_ISSUER, STELLAR_TESTNET_USDC_ISSUER, type StellarAssetSymbol, type StellarNetworkId } from "./shared";
import { StellarIntegrationError } from "./server";

/**
 * Classic XLM and official Mainnet USDC transfers over Horizon.
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

export function horizonServer(networkId?: StellarNetworkId): Horizon.Server {
  return new Horizon.Server(stellarNetwork(networkId).horizonUrl);
}

export function paymentAsset(currency: StellarAssetSymbol = "XLM", networkId?: StellarNetworkId): Asset {
  if (currency === "XLM") return Asset.native();
  const network = stellarNetwork(networkId).id;
  if (currency !== "USDC" || !["mainnet", "testnet"].includes(network)) throw new StellarIntegrationError("USDC wallet payments require the official Circle asset for the selected Stellar network.", "invalid_input");
  return new Asset("USDC", network === "mainnet" ? STELLAR_MAINNET_USDC_ISSUER : STELLAR_TESTNET_USDC_ISSUER);
}

const reserveCache = new Map<string, { units: bigint; expiresAt: number }>();
export async function baseReserveUnits(networkId?: StellarNetworkId): Promise<bigint> {
  const net = stellarNetwork(networkId);
  const cached = reserveCache.get(net.horizonUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.units;
  const response = await fetch(`${net.horizonUrl}/ledgers?order=desc&limit=1`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new StellarIntegrationError("The Stellar account reserve could not be verified.", "balance_unavailable");
  const payload = await response.json() as { _embedded?: { records?: { base_reserve_in_stroops: number }[] } };
  const value = payload._embedded?.records?.[0]?.base_reserve_in_stroops;
  if (!Number.isSafeInteger(value) || !value || value < 0) throw new StellarIntegrationError("The Stellar account reserve could not be verified.", "balance_unavailable");
  const units = BigInt(value);
  reserveCache.set(net.horizonUrl, { units, expiresAt: Date.now() + 60000 });
  return units;
}

export function decimalUnits(value: string): bigint {
  if (!/^\d+(?:\.\d{1,7})?$/.test(value)) throw new StellarIntegrationError("Enter an exact amount with up to seven decimal places.", "invalid_input");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, "0"));
}

export function unitDecimal(value: bigint): string {
  if (value < 0n) throw new StellarIntegrationError("Invalid balance.", "invalid_input");
  return `${value / 10_000_000n}.${(value % 10_000_000n).toString().padStart(7, "0")}`;
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
  usdc?: string;
  spendableUsdc?: string;
  usdcTrustline?: boolean;
  usdcAuthorized?: boolean;
  baseReserveXlm?: string;
}

export async function accountSnapshot(address: string, networkId?: StellarNetworkId): Promise<AccountSnapshot> {
  const server = horizonServer(networkId);
  try {
    const account = await server.loadAccount(address);
    const native = account.balances.find((balance) => balance.asset_type === "native");
    const subentries = account.subentry_count ?? 0;
    const baseReserve = await baseReserveUnits(networkId);
    const reserve = BigInt(2 + subentries + (account.num_sponsoring ?? 0) - (account.num_sponsored ?? 0)) * baseReserve;
    const spendable = decimalUnits(native?.balance ?? "0") - reserve - decimalUnits(native?.selling_liabilities ?? "0") - decimalUnits(String(FEE_HEADROOM_XLM));
    const issuer = stellarNetwork(networkId).id === "mainnet" ? STELLAR_MAINNET_USDC_ISSUER : STELLAR_TESTNET_USDC_ISSUER;
    const usdc = account.balances.find(balance => "asset_code" in balance && balance.asset_code === "USDC" && balance.asset_issuer === issuer);
    const usdcUnits = decimalUnits(usdc?.balance ?? "0") - decimalUnits(usdc && "selling_liabilities" in usdc ? usdc.selling_liabilities : "0");
    const authorized = Boolean(usdc && "is_authorized" in usdc && usdc.is_authorized);
    return {
      address,
      exists: true,
      xlm: native?.balance ?? "0",
      spendableXlm: unitDecimal(spendable > 0n ? spendable : 0n),
      reserveXlm: unitDecimal(reserve),
      subentries,
      usdc: usdc?.balance ?? "0", spendableUsdc: authorized && usdcUnits > 0n ? unitDecimal(usdcUnits) : "0", usdcTrustline: Boolean(usdc), usdcAuthorized: authorized,
      baseReserveXlm: unitDecimal(baseReserve),
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
  currency?: StellarAssetSymbol;
  networkId?: StellarNetworkId;
}): Promise<{ xdr: string; sequence: string }> {
  const net = stellarNetwork(input.networkId);
  const server = horizonServer(input.networkId);
  const asset = paymentAsset(input.currency, input.networkId);
  let account: Horizon.AccountResponse;
  try {
    account = await server.loadAccount(input.source);
  } catch (error) {
    if (isNotFound(error)) {
      throw new StellarIntegrationError(
        `This wallet has no funds on ${net.label} yet. Deposit XLM first, then try again.`,
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
        asset,
        amount: input.amountXlm,
      }),
    )
    .setTimeout(180)
    .build();

  return { xdr: transaction.toXDR(), sequence: account.sequence };
}

export function signPaymentXdr(xdrBase64: string, keypair: Keypair, networkId?: StellarNetworkId): string {
  const transaction = TransactionBuilder.fromXDR(xdrBase64, stellarNetwork(networkId).networkPassphrase) as Transaction;
  transaction.sign(keypair);
  return transaction.toXDR();
}

export interface SubmittedPayment {
  hash: string;
  ledger: number | null;
}

export async function submitPaymentXdr(xdrBase64: string, networkId?: StellarNetworkId): Promise<SubmittedPayment> {
  const server = horizonServer(networkId);
  const transaction = TransactionBuilder.fromXDR(xdrBase64, stellarNetwork(networkId).networkPassphrase) as Transaction;
  try {
    const response = await server.submitTransaction(transaction);
    return { hash: response.hash, ledger: response.ledger ?? null };
  } catch (error) {
    const detail = (error as { response?: { data?: { extras?: { result_codes?: unknown } } } })?.response?.data
      ?.extras?.result_codes;
    const codes = detail ? JSON.stringify(detail) : null;
    console.error("[chain-duel] Horizon rejected a payment:", codes ?? "unknown result code");
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

/** Creating a USDC trustline locks a base reserve; it never sends USDC. */
export async function buildUsdcTrustline(source: string): Promise<string> {
  const net = stellarNetwork();
  const asset = paymentAsset("USDC", net.id);
  const account = await horizonServer().loadAccount(source);
  return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: net.networkPassphrase })
    .addOperation(Operation.changeTrust({ asset })).setTimeout(180).build().toXDR();
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
