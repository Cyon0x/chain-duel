import "server-only";
import { TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { db } from "../db";
import { createTransaction, updateTransaction } from "../db/repositories/economy";
import { loadWalletKey, primaryWallet } from "../db/repositories/identity";
import type { TransactionRow } from "../db/types";
import { explorerAccountUrl, explorerTxUrl, stellarNetwork } from "../config/stellar";
import { xlmToStroops } from "../config/game";
import { ChainDuelError } from "./errors";
import {
  MAX_MEMO_LENGTH,
  accountSnapshot,
  buildPayment,
  fundTestnetAccount,
  isValidStellarAddress,
  signPaymentXdr,
  submitPaymentXdr,
  type AccountSnapshot,
} from "../stellar/payments";
import { managedKeypair } from "../stellar/wallet";

/**
 * Player-managed wallet operations.
 *
 * Custody has two shapes and both are first-class:
 *  - managed  → Chain Duel holds an encrypted key and signs server-side after
 *               verifying the session. The player never needs an extension.
 *  - external → the player's own wallet (Freighter, xBull, …) signs a payment
 *               we prepared. We still verify what they signed.
 *
 * Nothing here ever returns key material.
 */

export interface WalletTransfer {
  id: string;
  direction: "in" | "out";
  amount_stroops: number;
  destination: string | null;
  memo: string | null;
  status: string;
  tx_hash: string | null;
  explorer_url: string | null;
  created_at: string;
  confirmed_at: string | null;
  error: string | null;
}

export interface WalletOverview {
  address: string;
  provider: string;
  custody: "external" | "managed";
  label: string | null;
  canSignServerSide: boolean;
  network: { id: string; label: string; isTestnet: boolean; explorerUrl: string };
  balance: AccountSnapshot & { available: boolean };
  explorerUrl: string;
  transfers: WalletTransfer[];
}

async function ownerWallet(userId: string) {
  const database = await db();
  const wallet = await primaryWallet(database, userId);
  if (!wallet) {
    throw new ChainDuelError("No wallet is linked to this account.", "wallet_missing", 404);
  }
  return { database, wallet };
}

export async function walletOverview(userId: string): Promise<WalletOverview> {
  const { database, wallet } = await ownerWallet(userId);
  const net = stellarNetwork();

  let snapshot: AccountSnapshot;
  let available = true;
  try {
    snapshot = await accountSnapshot(wallet.address);
  } catch {
    // A horizon outage must not blank the whole page: show the address and say
    // the balance is unavailable instead of inventing a number.
    available = false;
    snapshot = { address: wallet.address, exists: false, xlm: "0", spendableXlm: "0", reserveXlm: "0", subentries: 0 };
  }

  let canSignServerSide = false;
  if (wallet.custody === "managed") {
    canSignServerSide = Boolean(await loadWalletKey(database, wallet.id));
  }

  // Deposits and sends are both wallet activity; duel entries and payouts live
  // on the transactions page instead.
  const rows = await database.query<TransactionRow>(
    "SELECT * FROM transactions WHERE user_id = ? AND kind IN ('transfer', 'deposit') ORDER BY created_at DESC LIMIT 20",
    [userId],
  );

  return {
    address: wallet.address,
    provider: wallet.provider,
    custody: wallet.custody,
    label: wallet.label,
    canSignServerSide,
    network: { id: net.id, label: net.label, isTestnet: net.isTestnet, explorerUrl: net.explorerUrl },
    balance: { ...snapshot, available },
    explorerUrl: explorerAccountUrl(wallet.address),
    transfers: rows.map((row) => {
      const metadata = safeMetadata(row.metadata);
      return {
        id: row.id,
        direction: row.direction,
        amount_stroops: row.amount_stroops,
        destination: row.address,
        memo: typeof metadata.memo === "string" ? metadata.memo : null,
        status: row.status,
        tx_hash: row.tx_hash,
        explorer_url: row.explorer_url,
        created_at: row.created_at,
        confirmed_at: row.confirmed_at,
        error: row.error,
      };
    }),
  };
}

function safeMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface TransferInput {
  userId: string;
  destination: string;
  amountXlm: string;
  memo?: string | null;
}

export type TransferHandoff =
  | { mode: "confirmed"; transactionId: string; txHash: string; ledger: number | null; explorerUrl: string }
  | { mode: "wallet-signature"; transactionId: string; xdr: string; networkPassphrase: string; summary: { destination: string; amountXlm: string } };

function parseAmount(amountXlm: string): number {
  const trimmed = amountXlm.trim();
  if (!/^\d+(\.\d{1,7})?$/.test(trimmed)) {
    throw new ChainDuelError("Enter an amount with up to 7 decimal places.", "invalid_amount");
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ChainDuelError("Enter an amount greater than zero.", "invalid_amount");
  }
  return value;
}

/** Prepares a transfer. Managed wallets complete immediately; external ones
 *  return an XDR for the player's wallet to sign. */
export async function startTransfer(input: TransferInput): Promise<TransferHandoff> {
  const { database, wallet } = await ownerWallet(input.userId);

  const destination = input.destination.trim();
  if (!isValidStellarAddress(destination)) {
    throw new ChainDuelError("That is not a valid Stellar address.", "invalid_address");
  }
  if (destination === wallet.address) {
    throw new ChainDuelError("You cannot send to your own wallet.", "self_transfer");
  }

  const amountXlm = parseAmount(input.amountXlm);
  const memo = input.memo?.trim() ? input.memo.trim().slice(0, MAX_MEMO_LENGTH) : null;

  const snapshot = await accountSnapshot(wallet.address);
  if (!snapshot.exists) {
    throw new ChainDuelError(
      "This wallet has no Testnet balance yet. Deposit XLM first, then try again.",
      "wallet_not_funded",
    );
  }
  if (amountXlm > Number(snapshot.spendableXlm) + 1e-9) {
    throw new ChainDuelError(
      `You can send at most ${snapshot.spendableXlm} XLM — the rest stays as the account reserve.`,
      "insufficient_balance",
    );
  }

  const amountStroops = xlmToStroops(amountXlm);
  const row = await createTransaction(database, {
    userId: input.userId,
    gameId: null,
    kind: "transfer",
    direction: "out",
    amountStroops,
    status: "preparing",
    address: destination,
    metadata: { memo, source: wallet.address, destination, amountXlm: amountXlm.toFixed(7), custody: wallet.custody },
  });

  const prepared = await buildPayment({
    source: wallet.address,
    destination,
    amountXlm: amountXlm.toFixed(7),
    memo,
  });

  if (wallet.custody === "managed") {
    const sealed = await loadWalletKey(database, wallet.id);
    if (sealed) {
      const keypair = managedKeypair({ ciphertext: sealed.ciphertext, iv: sealed.iv, authTag: sealed.auth_tag });
      try {
        await updateTransaction(database, row.id, { status: "signing" });
        const signed = signPaymentXdr(prepared.xdr, keypair);
        await updateTransaction(database, row.id, { status: "submitting" });
        const result = await submitPaymentXdr(signed);
        await updateTransaction(database, row.id, {
          status: "confirmed",
          txHash: result.hash,
          ledger: result.ledger,
          explorerUrl: explorerTxUrl(result.hash),
          confirmedAt: new Date().toISOString(),
          error: null,
        });
        return {
          mode: "confirmed",
          transactionId: row.id,
          txHash: result.hash,
          ledger: result.ledger,
          explorerUrl: explorerTxUrl(result.hash),
        };
      } catch (error) {
        await updateTransaction(database, row.id, {
          status: "failed",
          error: error instanceof Error ? error.message : "Transfer failed.",
        });
        throw error;
      }
    }
  }

  await updateTransaction(database, row.id, { status: "awaiting_wallet" });
  return {
    mode: "wallet-signature",
    transactionId: row.id,
    xdr: prepared.xdr,
    networkPassphrase: stellarNetwork().networkPassphrase,
    summary: { destination, amountXlm: amountXlm.toFixed(7) },
  };
}

/**
 * Submits a transfer the player's own wallet signed. The signed envelope is
 * re-validated against the recorded intent so a client cannot swap the
 * destination or amount after the fact.
 */
export async function completeTransfer(input: {
  userId: string;
  transactionId: string;
  signedXdr: string;
}): Promise<{ transactionId: string; txHash: string; ledger: number | null; explorerUrl: string }> {
  const { database, wallet } = await ownerWallet(input.userId);
  const row = await database.one<TransactionRow>(
    "SELECT * FROM transactions WHERE id = ? AND user_id = ? AND kind = 'transfer'",
    [input.transactionId, input.userId],
  );
  if (!row) throw new ChainDuelError("That transfer no longer exists.", "transfer_missing", 404);
  if (row.status === "confirmed") {
    return {
      transactionId: row.id,
      txHash: row.tx_hash ?? "",
      ledger: row.ledger,
      explorerUrl: row.explorer_url ?? "",
    };
  }
  if (row.status !== "awaiting_wallet") {
    throw new ChainDuelError("That transfer is no longer awaiting a signature.", "transfer_not_pending");
  }

  const metadata = safeMetadata(row.metadata);
  const expectedDestination = typeof metadata.destination === "string" ? metadata.destination : row.address;
  const rawAmount = metadata.amountXlm;
  const expectedAmountXlm =
    typeof rawAmount === "string" || typeof rawAmount === "number" ? String(rawAmount) : null;

  let parsed: Transaction;
  try {
    parsed = TransactionBuilder.fromXDR(input.signedXdr, stellarNetwork().networkPassphrase) as Transaction;
  } catch {
    throw new ChainDuelError("That signed transaction could not be read.", "invalid_xdr");
  }

  // The signature must come from the account's own wallet and must do exactly
  // what the player asked for — nothing more.
  if (parsed.source !== wallet.address) {
    throw new ChainDuelError("That signed transaction is for a different wallet.", "source_mismatch");
  }
  const payment = parsed.operations.find((operation) => operation.type === "payment");
  if (!payment || payment.type !== "payment") {
    throw new ChainDuelError("That transaction is not a payment.", "not_a_payment");
  }
  if (payment.destination !== expectedDestination) {
    throw new ChainDuelError("That signed transaction pays a different address.", "destination_mismatch");
  }
  if (expectedAmountXlm && Number(payment.amount).toFixed(7) !== Number(expectedAmountXlm).toFixed(7)) {
    throw new ChainDuelError("That signed transaction has a different amount.", "amount_mismatch");
  }

  try {
    await updateTransaction(database, row.id, { status: "submitting" });
    const result = await submitPaymentXdr(input.signedXdr);
    await updateTransaction(database, row.id, {
      status: "confirmed",
      txHash: result.hash,
      ledger: result.ledger,
      explorerUrl: explorerTxUrl(result.hash),
      confirmedAt: new Date().toISOString(),
      error: null,
    });
    return {
      transactionId: row.id,
      txHash: result.hash,
      ledger: result.ledger,
      explorerUrl: explorerTxUrl(result.hash),
    };
  } catch (error) {
    await updateTransaction(database, row.id, {
      status: "failed",
      error: error instanceof Error ? error.message : "Transfer failed.",
    });
    throw error;
  }
}

/** Testnet faucet: only for an unfunded account, and only on Testnet. */
export async function fundOwnWallet(userId: string): Promise<{ funded: boolean; message: string }> {
  const { database, wallet } = await ownerWallet(userId);
  const net = stellarNetwork();
  if (!net.isTestnet) {
    throw new ChainDuelError("The Testnet faucet is not available on this network.", "no_friendbot", 400);
  }
  const snapshot = await accountSnapshot(wallet.address);
  if (snapshot.exists && Number(snapshot.xlm) > 0) {
    throw new ChainDuelError("This wallet already has a Testnet balance.", "already_funded");
  }

  const row = await createTransaction(database, {
    userId,
    gameId: null,
    kind: "deposit",
    direction: "in",
    amountStroops: 10_000 * 10_000_000,
    status: "submitting",
    address: wallet.address,
    metadata: { source: "friendbot", address: wallet.address },
  });

  const result = await fundTestnetAccount(wallet.address).then(
    (value) => value,
    async (error: unknown) => {
      await updateTransaction(database, row.id, {
        status: "failed",
        error: error instanceof Error ? error.message : "Faucet failed.",
      });
      throw error;
    },
  );

  await updateTransaction(database, row.id, {
    status: "confirmed",
    txHash: result.hash ?? null,
    ledger: result.ledger ?? null,
    explorerUrl: result.hash ? explorerTxUrl(result.hash) : null,
    confirmedAt: new Date().toISOString(),
    error: null,
  });
  return { funded: true, message: "Testnet XLM added to your wallet." };
}
