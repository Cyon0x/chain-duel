import "server-only";
import { db } from "../db";
import { createTransaction, updateTransaction, listTransactionsForUser } from "../db/repositories/economy";
import type { GameRow, TransactionKind, TransactionRow } from "../db/types";
import { explorerTxUrl } from "../config/stellar";
import {
  StellarIntegrationError,
  invokeWithKeypair,
  latestLedger,
  settlementPublicKey,
  submitSignedXdr,
} from "../stellar/server";
import type { Keypair } from "@stellar/stellar-sdk";
import {
  MODE,
  contractConfigured,
  getAccruedFees,
  getBotLiquidity,
  getContractBalance,
  getLockedEscrow,
  getOnChainConfig,
  getOnChainStats,
  createGameArgs,
  joinGameArgs,
  prepareCreateGame,
  prepareJoinGame,
  serverSettleGame,
  serverStartGame,
} from "../stellar/contract";
import { stroopsToXlm } from "../config/game";

export type EscrowHandoff =
  | { mode: "offchain"; confirmed: true; transactionId: string }
  | { mode: "confirmed"; confirmed: true; transactionId: string; txHash: string }
  | {
      mode: "wallet-signature";
      confirmed: false;
      transactionId: string;
      xdr: string;
      networkPassphrase: string;
    };

export function onChainEscrowAvailable(): boolean {
  return contractConfigured() && settlementPublicKey() !== null;
}

/** Ledger-based expiry, ~5s per ledger with headroom for slow confirms. */
export async function ledgerForTimestamp(iso: string): Promise<number> {
  const now = Date.now();
  const target = new Date(iso).getTime();
  const deltaMs = Math.max(target - now, 60_000);
  const current = await latestLedger();
  return current + Math.ceil(deltaMs / 5_000) + 40;
}

async function markConfirmed(
  transactionId: string,
  result: { hash: string; ledger: number | null },
): Promise<void> {
  const database = await db();
  await updateTransaction(database, transactionId, {
    status: "confirmed",
    txHash: result.hash,
    ledger: result.ledger,
    explorerUrl: explorerTxUrl(result.hash),
    confirmedAt: new Date().toISOString(),
    error: null,
  });
}

async function markFailed(transactionId: string, error: string): Promise<void> {
  const database = await db();
  await updateTransaction(database, transactionId, { status: "failed", error });
}

async function newTransaction(input: {
  userId: string;
  gameId: string | null;
  kind: TransactionKind;
  direction: "in" | "out";
  amountStroops: number;
  address: string | null;
  demo: boolean;
  metadata?: unknown;
}): Promise<TransactionRow> {
  const database = await db();
  return createTransaction(database, {
    userId: input.userId,
    gameId: input.gameId,
    kind: input.kind,
    direction: input.direction,
    amountStroops: input.amountStroops,
    status: input.demo ? "confirmed" : "preparing",
    address: input.address,
    demo: input.demo,
    metadata: input.metadata,
    txHash: null,
  });
}

/**
 * Locks a player's entry for a duel.
 *
 * - demo duel     → no value moves (clearly marked as a demo in the ledger).
 * - managed wallet → the server signs with the player's sealed key.
 * - external wallet → the player's wallet signs a prepared Soroban invocation.
 */
export async function lockEntry(input: {
  game: GameRow;
  userId: string;
  address: string;
  custody: "external" | "managed";
  keypair?: Keypair | null;
}): Promise<EscrowHandoff> {
  const demo = Boolean(input.game.demo);
  const transaction = await newTransaction({
    userId: input.userId,
    gameId: input.game.id,
    kind: "entry",
    direction: "out",
    amountStroops: input.game.entry_stroops,
    address: input.address,
    demo,
    metadata: { gameCode: input.game.code, mode: input.game.mode },
  });

  if (demo) return { mode: "offchain", confirmed: true, transactionId: transaction.id };
  if (!onChainEscrowAvailable() || !input.game.contract_game_id) {
    await markFailed(transaction.id, "Escrow contract is not configured.");
    throw new StellarIntegrationError(
      "Escrow is unavailable: the Chain Duel contract is not configured on this deployment.",
      "not_configured",
    );
  }

  const database = await db();
  if (input.custody === "managed" && input.keypair) {
    try {
      await updateTransaction(database, transaction.id, { status: "signing" });
      const expiryLedger = await ledgerForTimestamp(input.game.expires_at);
      const result = await invokeWithKeypair({
        keypair: input.keypair,
        method: "create_game",
        args: createGameArgs({
          creator: input.address,
          gameIdHex: input.game.contract_game_id,
          mode: input.game.mode === "bot" ? MODE.bot : MODE.pvp,
          entryStroops: input.game.entry_stroops,
          expiryLedger,
        }),
      });
      await markConfirmed(transaction.id, result);
      return { mode: "confirmed", confirmed: true, transactionId: transaction.id, txHash: result.hash };
    } catch (error) {
      await markFailed(transaction.id, messageOf(error));
      throw error;
    }
  }

  const expiryLedger = await ledgerForTimestamp(input.game.expires_at);
  const prepared = await prepareCreateGame({
    creator: input.address,
    gameIdHex: input.game.contract_game_id,
    mode: input.game.mode === "bot" ? MODE.bot : MODE.pvp,
    entryStroops: input.game.entry_stroops,
    expiryLedger,
  });
  await updateTransaction(database, transaction.id, { status: "awaiting_wallet" });
  return {
    mode: "wallet-signature",
    confirmed: false,
    transactionId: transaction.id,
    xdr: prepared.xdr,
    networkPassphrase: (await import("../config/stellar")).stellarNetwork().networkPassphrase,
  };
}

/** Second player locks the matching entry. */
export async function lockJoin(input: {
  game: GameRow;
  userId: string;
  address: string;
  custody: "external" | "managed";
  keypair?: Keypair | null;
}): Promise<EscrowHandoff> {
  const demo = Boolean(input.game.demo);
  const transaction = await newTransaction({
    userId: input.userId,
    gameId: input.game.id,
    kind: "entry",
    direction: "out",
    amountStroops: input.game.entry_stroops,
    address: input.address,
    demo,
    metadata: { gameCode: input.game.code, role: "joiner" },
  });

  if (demo) return { mode: "offchain", confirmed: true, transactionId: transaction.id };
  if (!onChainEscrowAvailable() || !input.game.contract_game_id) {
    await markFailed(transaction.id, "Escrow contract is not configured.");
    throw new StellarIntegrationError(
      "Escrow is unavailable: the Chain Duel contract is not configured on this deployment.",
      "not_configured",
    );
  }

  const database = await db();
  if (input.custody === "managed" && input.keypair) {
    try {
      await updateTransaction(database, transaction.id, { status: "signing" });
      const result = await invokeWithKeypair({
        keypair: input.keypair,
        method: "join_game",
        args: joinGameArgs({ player: input.address, gameIdHex: input.game.contract_game_id }),
      });
      await markConfirmed(transaction.id, result);
      return { mode: "confirmed", confirmed: true, transactionId: transaction.id, txHash: result.hash };
    } catch (error) {
      await markFailed(transaction.id, messageOf(error));
      throw error;
    }
  }

  const prepared = await prepareJoinGame({
    player: input.address,
    gameIdHex: input.game.contract_game_id,
  });
  await updateTransaction(database, transaction.id, { status: "awaiting_wallet" });
  return {
    mode: "wallet-signature",
    confirmed: false,
    transactionId: transaction.id,
    xdr: prepared.xdr,
    networkPassphrase: (await import("../config/stellar")).stellarNetwork().networkPassphrase,
  };
}

/** Submits a wallet-signed XDR and confirms it on chain. */
export async function submitWalletSigned(input: {
  transactionId: string;
  signedXdr: string;
}): Promise<{ txHash: string; ledger: number | null }> {
  const database = await db();
  await updateTransaction(database, input.transactionId, { status: "submitting" });
  try {
    const result = await submitSignedXdr(input.signedXdr);
    await markConfirmed(input.transactionId, result);
    return { txHash: result.hash, ledger: result.ledger };
  } catch (error) {
    await markFailed(input.transactionId, messageOf(error));
    throw error;
  }
}

export async function markTransactionFailed(transactionId: string, error: string): Promise<void> {
  await markFailed(transactionId, error);
}

export async function markTransactionAwaitingWallet(transactionId: string): Promise<void> {
  const database = await db();
  await updateTransaction(database, transactionId, { status: "awaiting_wallet" });
}

export interface SettlementOutcome {
  txHash: string | null;
  ledger: number | null;
  mode: "onchain" | "offchain";
}

/** Starts the duel on chain so the escrow is provably locked as ACTIVE. */
export async function beginOnChainGame(game: GameRow): Promise<string | null> {
  if (game.demo || !game.contract_game_id || !onChainEscrowAvailable()) return null;
  const result = await serverStartGame(game.contract_game_id);
  return result.hash;
}

export async function settleOnChain(input: {
  game: GameRow;
  winnerAddress: string;
  playerOneScore: number;
  playerTwoScore: number;
  resultHashHex: string;
}): Promise<SettlementOutcome> {
  if (input.game.demo || !input.game.contract_game_id || !onChainEscrowAvailable()) {
    return { txHash: null, ledger: null, mode: "offchain" };
  }
  // No ledger writes happen here: the winner payout and protocol fee rows are
  // written once, inside the settlement transaction, so one chain settlement
  // can never produce duplicate or misattributed history entries.
  const result = await serverSettleGame({
    gameIdHex: input.game.contract_game_id,
    winner: input.winnerAddress,
    playerOneScore: input.playerOneScore,
    playerTwoScore: input.playerTwoScore,
    resultHashHex: input.resultHashHex,
  });
  return { txHash: result.hash, ledger: result.ledger, mode: "onchain" };
}

export interface TreasurySnapshot {
  available: boolean;
  botLiquidityStroops: number;
  accruedFeesStroops: number;
  lockedEscrowStroops: number;
  contractBalanceStroops: number;
  paused: boolean;
  botEnabled: boolean;
  adminAddress: string | null;
  treasuryAddress: string | null;
  maxEntryStroops: number;
  maxPayoutStroops: number;
  minTreasuryBalanceStroops: number;
  stats: TreasuryStats;
}

/** On-chain stats with stroop totals narrowed to JSON-safe numbers. */
export type TreasuryStats =
  | (Omit<NonNullable<Awaited<ReturnType<typeof getOnChainStats>>>, "volume" | "feesCollected" | "payoutTotal" | "botPayouts"> & {
      volume: number;
      feesCollected: number;
      payoutTotal: number;
      botPayouts: number;
    })
  | null;

export async function treasurySnapshot(): Promise<TreasurySnapshot> {
  if (!contractConfigured()) {
    return {
      available: false,
      botLiquidityStroops: 0,
      accruedFeesStroops: 0,
      lockedEscrowStroops: 0,
      contractBalanceStroops: 0,
      paused: false,
      botEnabled: false,
      adminAddress: null,
      treasuryAddress: null,
      maxEntryStroops: 0,
      maxPayoutStroops: 0,
      minTreasuryBalanceStroops: 0,
      stats: null,
    };
  }
  const [config, aggregate] = await Promise.all([getOnChainConfig(), readAggregates()]);
  const stats = await getOnChainStats();
  return {
    available: true,
    botLiquidityStroops: aggregate.botLiquidity,
    accruedFeesStroops: aggregate.accruedFees,
    lockedEscrowStroops: aggregate.lockedEscrow,
    contractBalanceStroops: aggregate.contractBalance,
    paused: config?.paused ?? false,
    botEnabled: config?.botEnabled ?? false,
    adminAddress: config?.admin ?? null,
    treasuryAddress: config?.treasury ?? null,
    maxEntryStroops: Number(config?.maxEntry ?? 0n),
    maxPayoutStroops: Number(config?.maxPayout ?? 0n),
    minTreasuryBalanceStroops: Number(config?.minTreasuryBalance ?? 0n),
    // Stroop totals fit safely in a double, and the dashboard payload is JSON,
    // which cannot carry bigint at all.
    stats: stats
      ? {
          ...stats,
          volume: Number(stats.volume),
          feesCollected: Number(stats.feesCollected),
          payoutTotal: Number(stats.payoutTotal),
          botPayouts: Number(stats.botPayouts),
        }
      : null,
  };
}

async function readAggregates() {
  const [botLiquidity, accruedFees, lockedEscrow, contractBalance] = await Promise.all([
    getBotLiquidity().catch(() => 0n),
    getAccruedFees().catch(() => 0n),
    getLockedEscrow().catch(() => 0n),
    getContractBalance().catch(() => 0n),
  ]);
  return {
    botLiquidity: Number(botLiquidity),
    accruedFees: Number(accruedFees),
    lockedEscrow: Number(lockedEscrow),
    contractBalance: Number(contractBalance),
  };
}

export async function listUserTransactions(userId: string, limit = 40): Promise<TransactionRow[]> {
  const database = await db();
  return listTransactionsForUser(database, userId, { limit });
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function formatStroops(stroops: number): string {
  return stroopsToXlm(stroops).toFixed(2);
}
