import "server-only";
import { Asset, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { createHash } from "node:crypto";
import { db } from "../db";
import { createTransaction, updateTransaction } from "../db/repositories/economy";
import { loadWalletKey, primaryWallet } from "../db/repositories/identity";
import type { TransactionRow } from "../db/types";
import { explorerAccountUrl, explorerTxUrl, stellarNetwork } from "../config/stellar";
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
import { executeStellarIntent, stellarTransactionExpiredWithoutReceipt } from "../stellar/intents";
import { transactionReceipt } from "../stellar/server";
import { financialNetwork, financialSymbol, STELLAR_MAINNET_USDC, type StellarAssetSymbol, type StellarNetworkId } from "../stellar/shared";
import { decimalUnits, unitDecimal, paymentAsset, baseReserveUnits, buildUsdcTrustline } from "../stellar/payments";
import { syncMainnetWalletDeposits } from "./wallet-history";
import { playerControlledSigningEnabled, stellarVerificationEnabled } from "../config/stellar-verification";
import { publicStellarConfig } from "../config/stellar";

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
  currency: StellarAssetSymbol;
  stellar_network: StellarNetworkId;
}

export interface WalletOverview {
  playerControlledSigning?: boolean;
  address: string;
  provider: string;
  custody: "external" | "managed";
  label: string | null;
  canSignServerSide: boolean;
  network: { id: string; label: string; isTestnet: boolean; explorerUrl: string };
  balance: AccountSnapshot & { available: boolean };
  explorerUrl: string;
  transfers: WalletTransfer[];
  currency: StellarAssetSymbol;
  depositHistoryAvailable?: boolean;
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
  let depositHistoryAvailable = true;
  if (net.id === "mainnet" || stellarVerificationEnabled()) {
    try { await syncMainnetWalletDeposits(database, userId, wallet.address, net.id); }
    catch { depositHistoryAvailable = false; }
  }

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
  if (wallet.custody === "managed" && !playerControlledSigningEnabled()) {
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
    ...(playerControlledSigningEnabled() ? { playerControlledSigning: true } : {}),
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
        currency: financialSymbol(row),
        stellar_network: financialNetwork(row),
      };
    }),
    currency: publicStellarConfig().asset.symbol,
    depositHistoryAvailable,
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
  currency?: StellarAssetSymbol;
  networkId?: string;
  requestId?: string;
}

export type TransferHandoff =
  | { mode: "confirmed"; transactionId: string; txHash: string; ledger: number | null; explorerUrl: string }
  | { mode: "wallet-signature"; transactionId: string; xdr: string; networkPassphrase: string; summary: { destination: string; amountXlm: string; currency?: StellarAssetSymbol } };

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
  const net = stellarNetwork();
  const currency = input.currency ?? "XLM";
  paymentAsset(currency, net.id);
  if (input.networkId && ![net.id, `stellar-${net.id}`].includes(input.networkId)) throw new ChainDuelError("The wallet transfer belongs to a different network. Refresh before signing.", "wrong_network", 409);
  if (net.id === "mainnet" && (!input.networkId || !input.currency || !input.requestId)) throw new ChainDuelError("Refresh the wallet before preparing a Mainnet transfer.", "financial_context_required", 409);

  const destination = input.destination.trim();
  if (!isValidStellarAddress(destination)) {
    throw new ChainDuelError("That is not a valid Stellar address.", "invalid_address");
  }
  if (destination === wallet.address) {
    throw new ChainDuelError("You cannot send to your own wallet.", "self_transfer");
  }

  parseAmount(input.amountXlm);
  const amountUnits = decimalUnits(input.amountXlm.trim());
  if (amountUnits > BigInt(Number.MAX_SAFE_INTEGER)) throw new ChainDuelError("This amount cannot be represented safely.", "invalid_amount");
  const memo = input.memo?.trim() ? input.memo.trim().slice(0, MAX_MEMO_LENGTH) : null;
  const amountStroops = Number(amountUnits);
  if (input.requestId && !/^[A-Za-z0-9_-]{8,100}$/.test(input.requestId)) throw new ChainDuelError("Invalid transfer request id.", "invalid_input");
  const id = input.requestId ? `txn_stellar_${createHash("sha256").update(`${net.id}:${input.userId}:${input.requestId}`).digest("hex")}` : undefined;
  let row = id ? await database.one<TransactionRow>("SELECT * FROM transactions WHERE id = ?", [id]) : null;
  const checkRequest = (saved: TransactionRow) => {
    if (saved.user_id !== input.userId || saved.kind !== "transfer" || saved.address !== destination || saved.amount_stroops !== amountStroops || financialSymbol(saved) !== currency || financialNetwork(saved) !== net.id || safeMetadata(saved.metadata).memo !== memo || safeMetadata(saved.metadata).source !== wallet.address) throw new ChainDuelError("That transfer request was already used with different parameters.", "intent_mismatch", 409);
  };
  if (row) checkRequest(row);
  if (row?.status === "confirmed" && row.tx_hash) return { mode: "confirmed", transactionId: row.id, txHash: row.tx_hash, ledger: row.ledger, explorerUrl: row.explorer_url ?? explorerTxUrl(row.tx_hash, financialNetwork(row)) };

  const verifyBalance = async () => {
  const snapshot = await accountSnapshot(wallet.address);
  if (!snapshot.exists) {
    throw new ChainDuelError(
      net.isTestnet ? "This wallet has no Testnet balance yet. Deposit XLM first, then try again." : "This wallet is not funded on Stellar Mainnet yet. Deposit XLM to activate it.",
      "wallet_not_funded",
    );
  }
  const spendable = currency === "USDC" ? snapshot.spendableUsdc ?? "0" : snapshot.spendableXlm;
  if (amountUnits > decimalUnits(spendable)) {
    throw new ChainDuelError(
      currency === "XLM" ? `You can send at most ${snapshot.spendableXlm} XLM — the rest stays as the account reserve.` : `You can send at most ${spendable} USDC from this wallet.`,
      "insufficient_balance",
    );
  }
  if (currency === "USDC") {
    const nativeAvailable = decimalUnits(snapshot.xlm) - decimalUnits(snapshot.reserveXlm);
    if (!snapshot.usdcAuthorized || nativeAvailable < 100n) throw new ChainDuelError("An authorized USDC trustline and XLM for the network fee are required.", "wallet_not_ready", 409);
    const recipient = await accountSnapshot(destination);
    if (!recipient.exists || !recipient.usdcAuthorized) throw new ChainDuelError(`The recipient needs an active wallet on ${net.label} and an authorized official USDC trustline.`, "destination_not_ready", 409);
  }
  };
  if (!row) await verifyBalance();
  row ??= await createTransaction(database, {
    id,
    userId: input.userId,
    gameId: null,
    kind: "transfer",
    direction: "out",
    amountStroops,
    status: "preparing",
    address: destination,
    stellarNetwork: net.id, currency,
    metadata: { memo, source: wallet.address, destination, amountXlm: unitDecimal(amountUnits), currency, custody: wallet.custody },
  });
  checkRequest(row);

  const prepare = async () => {
    await verifyBalance();
    return buildPayment({
    source: wallet.address,
    destination,
    amountXlm: unitDecimal(amountUnits),
    memo,
    currency, networkId: net.id,
  });
  };

  if (wallet.custody === "managed" && !playerControlledSigningEnabled()) {
    const sealed = await loadWalletKey(database, wallet.id);
    if (sealed) {
      const keypair = managedKeypair({ ciphertext: sealed.ciphertext, iv: sealed.iv, authTag: sealed.auth_tag });
      if (net.id === "mainnet" && keypair.publicKey() !== wallet.address) throw new ChainDuelError("The managed wallet signer does not match its recorded address.", "wallet_key_mismatch", 503);
      try {
        await updateTransaction(database, row.id, { status: "signing" });
        const result = await executeWalletPayment(row, wallet.address, async () => signPaymentXdr((await prepare()).xdr, keypair, net.id));
        await updateTransaction(database, row.id, {
          status: "confirmed",
          txHash: result.hash,
          ledger: result.ledger,
          explorerUrl: explorerTxUrl(result.hash, net.id),
          confirmedAt: new Date().toISOString(),
          error: null,
        });
        return {
          mode: "confirmed",
          transactionId: row.id,
          txHash: result.hash,
          ledger: result.ledger,
          explorerUrl: explorerTxUrl(result.hash, net.id),
        };
      } catch (error) {
        await updateTransaction(database, row.id, {
          status: net.id === "mainnet" && (await database.one<TransactionRow>("SELECT * FROM transactions WHERE id = ?", [row.id]))?.tx_hash ? "submitting" : "failed",
          error: error instanceof Error ? error.message : "Transfer failed.",
        });
        throw error;
      }
    }
  }

  return prepareExternalWalletPayment(row, async () => (await prepare()).xdr, { destination, amountXlm: unitDecimal(amountUnits), currency });
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
  if (!["awaiting_wallet", "submitting", "failed"].includes(row.status)) {
    throw new ChainDuelError("That transfer is no longer awaiting a signature.", "transfer_not_pending");
  }

  const metadata = safeMetadata(row.metadata);
  const expectedDestination = typeof metadata.destination === "string" ? metadata.destination : row.address;
  const rawAmount = metadata.amountXlm;
  const expectedAmountXlm =
    typeof rawAmount === "string" || typeof rawAmount === "number" ? String(rawAmount) : null;

  let parsed: Transaction;
  try {
    parsed = TransactionBuilder.fromXDR(input.signedXdr, stellarNetwork(financialNetwork(row)).networkPassphrase) as Transaction;
  } catch {
    throw new ChainDuelError("That signed transaction could not be read.", "invalid_xdr");
  }

  // The signature must come from the account's own wallet and must do exactly
  // what the player asked for — nothing more.
  if (parsed.source !== wallet.address) {
    throw new ChainDuelError("That signed transaction is for a different wallet.", "source_mismatch");
  }
  const payment = parsed.operations[0];
  if (parsed.operations.length !== 1 || (payment?.source && payment.source !== wallet.address)) throw new ChainDuelError("That transaction includes an unexpected wallet operation.", "invalid_xdr");
  if (!payment || payment.type !== "payment") {
    throw new ChainDuelError("That transaction is not a payment.", "not_a_payment");
  }
  if (payment.destination !== expectedDestination) {
    throw new ChainDuelError("That signed transaction pays a different address.", "destination_mismatch");
  }
  const expectedAsset = paymentAsset(financialSymbol(row), financialNetwork(row));
  if (!payment.asset.equals(expectedAsset)) throw new ChainDuelError("That payment uses a different asset or USDC issuer.", "asset_mismatch");
  if (expectedAmountXlm && decimalUnits(payment.amount) !== decimalUnits(expectedAmountXlm)) {
    throw new ChainDuelError("That signed transaction has a different amount.", "amount_mismatch");
  }
  const hash = Buffer.from(parsed.hash()).toString("hex");
  if (financialNetwork(row) === "mainnet" && (!row.prepared_hash || row.prepared_hash !== hash)) throw new ChainDuelError("That signed transaction differs from the prepared Mainnet transfer.", "intent_mismatch", 409);
  if (row.tx_hash && row.tx_hash !== hash) throw new ChainDuelError("A different transaction was already submitted for this transfer.", "intent_mismatch", 409);

  try {
    await updateTransaction(database, row.id, { status: "submitting" });
    const result = await executeWalletPayment(row, wallet.address, async () => input.signedXdr);
    await updateTransaction(database, row.id, {
      status: "confirmed",
      txHash: result.hash,
      ledger: result.ledger,
      explorerUrl: explorerTxUrl(result.hash, financialNetwork(row)),
      confirmedAt: new Date().toISOString(),
      error: null,
    });
    return {
      transactionId: row.id,
      txHash: result.hash,
      ledger: result.ledger,
      explorerUrl: explorerTxUrl(result.hash, financialNetwork(row)),
    };
  } catch (error) {
    await updateTransaction(database, row.id, {
      status: financialNetwork(row) === "mainnet" ? "submitting" : "failed",
      error: error instanceof Error ? error.message : "Transfer failed.",
    });
    throw error;
  }
}

async function executeWalletPayment(row: TransactionRow, source: string, prepare: () => Promise<string>) {
  const network = financialNetwork(row);
  if (network !== "mainnet") return submitPaymentXdr(await prepare(), network);
  return executeStellarIntent({
    id: `stellar-wallet:${row.id}`, networkId: network, address: source,
    contractId: financialSymbol(row) === "USDC" ? STELLAR_MAINNET_USDC : stellarNetwork(network).nativeTokenContractId,
    method: row.kind, argsHash: createHash("sha256").update(`${row.id}:${row.metadata}:${row.amount_stroops}:${financialSymbol(row)}`).digest("hex"),
    prepare: async () => {
      const signed = await prepare();
      const transaction = TransactionBuilder.fromXDR(signed, stellarNetwork(network).networkPassphrase);
      await updateTransaction(await db(), row.id, { status: "submitting", txHash: Buffer.from(transaction.hash()).toString("hex") });
      return signed;
    },
    submit: async signed => ({ ...await submitPaymentXdr(signed, network), returnValue: null, status: "SUCCESS" as const }),
    receipt: hash => transactionReceipt(hash, network),
  });
}

async function prepareExternalWalletPayment(row: TransactionRow, prepare: () => Promise<string>, summary: { destination: string; amountXlm: string; currency: StellarAssetSymbol }): Promise<TransferHandoff> {
  const database = await db();
  const network = financialNetwork(row);
  const passphrase = stellarNetwork(network).networkPassphrase;
  if (network !== "mainnet") {
    const unsigned = await prepare();
    await updateTransaction(database, row.id, { status: "awaiting_wallet", preparedHash: Buffer.from(TransactionBuilder.fromXDR(unsigned, passphrase).hash()).toString("hex") });
    return { mode: "wallet-signature", transactionId: row.id, xdr: unsigned, networkPassphrase: passphrase, summary };
  }
  let draft = await database.one<{ unsigned_xdr: string; tx_hash: string; max_time: number }>("SELECT * FROM stellar_wallet_drafts WHERE transaction_id = ?", [row.id]);
  if (draft && network === "mainnet") {
    const receipt = await transactionReceipt(draft.tx_hash, network);
    if (receipt && receipt !== "FAILED") {
      await updateTransaction(database, row.id, { status: "confirmed", txHash: receipt.hash, ledger: receipt.ledger, explorerUrl: explorerTxUrl(receipt.hash, network), confirmedAt: new Date().toISOString(), error: null });
      return { mode: "confirmed", transactionId: row.id, txHash: receipt.hash, ledger: receipt.ledger, explorerUrl: explorerTxUrl(receipt.hash, network) };
    }
    if (receipt === "FAILED" || await stellarTransactionExpiredWithoutReceipt(draft.tx_hash, Number(draft.max_time), network)) {
      await database.execute("DELETE FROM stellar_wallet_drafts WHERE transaction_id = ? AND tx_hash = ?", [row.id, draft.tx_hash]);
      await updateTransaction(database, row.id, { txHash: null });
      draft = null;
    }
  }
  if (!draft) {
    const unsigned = await prepare();
    const tx = TransactionBuilder.fromXDR(unsigned, passphrase) as Transaction;
    const hash = Buffer.from(tx.hash()).toString("hex");
    await database.execute("INSERT INTO stellar_wallet_drafts(transaction_id,unsigned_xdr,tx_hash,max_time) VALUES(?,?,?,?) ON CONFLICT(transaction_id) DO NOTHING", [row.id, unsigned, hash, Number(tx.timeBounds?.maxTime ?? 0)]);
    draft = await database.one("SELECT * FROM stellar_wallet_drafts WHERE transaction_id = ?", [row.id]);
  }
  if (!draft) throw new ChainDuelError("The wallet draft could not be saved.", "database_unavailable", 503);
  await updateTransaction(database, row.id, { status: "awaiting_wallet", preparedHash: draft.tx_hash });
  return { mode: "wallet-signature", transactionId: row.id, xdr: draft.unsigned_xdr, networkPassphrase: passphrase, summary };
}

export async function startUsdcTrustline(input: { userId: string; networkId?: string; requestId?: string }): Promise<TransferHandoff | { mode: "ready" }> {
  const network = stellarNetwork().id;
  if ((network !== "mainnet" && !(network === "testnet" && stellarVerificationEnabled())) || input.networkId !== `stellar-${network}` || !input.requestId || !/^[A-Za-z0-9_-]{8,100}$/.test(input.requestId)) throw new ChainDuelError("Refresh the wallet before preparing its official USDC trustline.", "financial_context_required", 409);
  const { database, wallet } = await ownerWallet(input.userId);
  const id = `txn_trust_${createHash("sha256").update(`${input.userId}:${input.requestId}`).digest("hex")}`;
  let row = await database.one<TransactionRow>("SELECT * FROM transactions WHERE id = ?", [id]);
  if (row && (row.user_id !== input.userId || row.kind !== "trustline" || row.address !== wallet.address || financialNetwork(row) !== network)) throw new ChainDuelError("That USDC setup belongs to a different wallet.", "intent_mismatch", 409);
  if (row?.status === "confirmed" && row.tx_hash) return { mode: "confirmed", transactionId: row.id, txHash: row.tx_hash, ledger: row.ledger, explorerUrl: explorerTxUrl(row.tx_hash, network) };
  const snapshot = await accountSnapshot(wallet.address);
  if (snapshot.usdcAuthorized && !row?.tx_hash) return { mode: "ready" };
  const reserve = await baseReserveUnits(network);
  if (!row?.tx_hash && (!snapshot.exists || decimalUnits(snapshot.xlm) < decimalUnits(snapshot.reserveXlm) + reserve + 100n)) throw new ChainDuelError(`Fund this wallet with XLM first. USDC setup reserves another ${unitDecimal(reserve)} XLM plus the network fee.`, "insufficient_balance", 409);
  row ??= await createTransaction(database, { id, userId: input.userId, kind: "trustline", direction: "out", amountStroops: 0, address: wallet.address, stellarNetwork: network, currency: "XLM", metadata: { source: wallet.address, issuer: paymentAsset("USDC").getIssuer(), reserveXlm: unitDecimal(reserve) } });
  const sealed = wallet.custody === "managed" && !playerControlledSigningEnabled() ? await loadWalletKey(database, wallet.id) : null;
  if (sealed) {
    const signer = managedKeypair({ ciphertext: sealed.ciphertext, iv: sealed.iv, authTag: sealed.auth_tag });
    if (signer.publicKey() !== wallet.address) throw new ChainDuelError("The managed wallet signer does not match its recorded address.", "wallet_key_mismatch", 503);
    const result = await executeWalletPayment(row, wallet.address, async () => signPaymentXdr(await buildUsdcTrustline(wallet.address), signer, network));
    await updateTransaction(database, row.id, { status: "confirmed", txHash: result.hash, ledger: result.ledger, explorerUrl: explorerTxUrl(result.hash, network), confirmedAt: new Date().toISOString(), error: null });
    return { mode: "confirmed", transactionId: row.id, txHash: result.hash, ledger: result.ledger, explorerUrl: explorerTxUrl(result.hash, network) };
  }
  return prepareExternalWalletPayment(row, () => buildUsdcTrustline(wallet.address), { destination: wallet.address, amountXlm: "0", currency: "USDC" });
}

export async function completeUsdcTrustline(input: { userId: string; transactionId: string; signedXdr: string }) {
  const { database, wallet } = await ownerWallet(input.userId);
  const row = await database.one<TransactionRow>("SELECT * FROM transactions WHERE id = ? AND user_id = ? AND kind = 'trustline'", [input.transactionId, input.userId]);
  const network = row ? financialNetwork(row) : stellarNetwork().id;
  if (!row || network !== stellarNetwork().id || row.address !== wallet.address) throw new ChainDuelError("This USDC setup does not belong to the connected wallet.", "forbidden", 403);
  if (row.status === "confirmed" && row.tx_hash) return { txHash: row.tx_hash, explorerUrl: explorerTxUrl(row.tx_hash, network) };
  let tx: Transaction;
  try { tx = TransactionBuilder.fromXDR(input.signedXdr, stellarNetwork(network).networkPassphrase) as Transaction; }
  catch { throw new ChainDuelError("The signed USDC setup could not be read.", "invalid_xdr"); }
  const operation = tx.operations[0];
  if (tx.source !== wallet.address || tx.operations.length !== 1 || operation.type !== "changeTrust" || (operation.source && operation.source !== wallet.address) || !(operation.line instanceof Asset) || !operation.line.equals(paymentAsset("USDC", network)) || !operation.limit || decimalUnits(operation.limit) === 0n || !row.prepared_hash || Buffer.from(tx.hash()).toString("hex") !== row.prepared_hash) throw new ChainDuelError("The signed transaction differs from the prepared USDC setup.", "intent_mismatch", 409);
  const result = await executeWalletPayment(row, wallet.address, async () => input.signedXdr);
  await updateTransaction(database, row.id, { status: "confirmed", txHash: result.hash, ledger: result.ledger, explorerUrl: explorerTxUrl(result.hash, network), confirmedAt: new Date().toISOString(), error: null });
  return { txHash: result.hash, explorerUrl: explorerTxUrl(result.hash, network) };
}

/** Confirm or rebroadcast only the exact transaction already authorized and
 * saved for this user's wallet. Recovery never generates a new payment. */
export async function recoverWalletTransaction(userId: string, transactionId: string) {
  const { database, wallet } = await ownerWallet(userId);
  const row = await database.one<TransactionRow>("SELECT * FROM transactions WHERE id = ? AND user_id = ? AND kind IN ('transfer','trustline')", [transactionId, userId]);
  if (!row || financialNetwork(row) !== "mainnet" || safeMetadata(row.metadata).source !== wallet.address) throw new ChainDuelError("This saved transfer does not belong to the connected wallet.", "forbidden", 403);
  if (row.status === "confirmed" && row.tx_hash) return { txHash: row.tx_hash, explorerUrl: explorerTxUrl(row.tx_hash, "mainnet") };
  if (!row.tx_hash) throw new ChainDuelError("This transfer has no saved signed transaction to recover.", "transfer_not_pending", 409);
  const result = await executeWalletPayment(row, wallet.address, async () => { throw new ChainDuelError("The previous payment did not execute and has expired. Prepare and approve a new transfer.", "transaction_expired", 409); });
  await updateTransaction(database, row.id, { status: "confirmed", txHash: result.hash, ledger: result.ledger, explorerUrl: explorerTxUrl(result.hash, "mainnet"), confirmedAt: new Date().toISOString(), error: null });
  return { txHash: result.hash, explorerUrl: explorerTxUrl(result.hash, "mainnet") };
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
