import "server-only";
import { xdr } from "@stellar/stellar-sdk";
import { contractId } from "../config/stellar";
import {
  invokeWithServerKey,
  prepareInvocation,
  readContractState,
  scv,
  settlementPublicKey,
} from "./server";

/**
 * Typed facade over the Chain Duel Soroban contract.
 *
 * Mode and status are plain u32 on the wire (pinned by the Rust test
 * `abi_constants_match_the_typescript_client`), so there is no enum-encoding
 * ambiguity between the two languages.
 */

export const MODE = { pvp: 0, bot: 1 } as const;
export type ContractMode = (typeof MODE)[keyof typeof MODE];

export const STATUS = {
  waiting: 0,
  joined: 1,
  active: 2,
  finished: 3,
  settled: 4,
  cancelled: 5,
  expired: 6,
} as const;
export type ContractStatus = (typeof STATUS)[keyof typeof STATUS];

export function contractConfigured(): boolean {
  try {
    return contractId() !== null;
  } catch {
    return false;
  }
}

export interface OnChainGame {
  id: string;
  mode: number;
  creator: string;
  opponent: string | null;
  entryAmount: bigint;
  botStake: bigint;
  feeBps: number;
  status: number;
  winner: string | null;
  playerOneScore: number;
  playerTwoScore: number;
  createdLedger: number;
  expiryLedger: number;
  settledLedger: number;
  escrow: bigint;
  payout: bigint;
  fee: bigint;
  resultHash: string;
}

export interface OnChainConfig {
  admin: string;
  treasury: string;
  token: string;
  feeBps: number;
  paused: boolean;
  botEnabled: boolean;
  maxEntry: bigint;
  maxPayout: bigint;
  minTreasuryBalance: bigint;
}

export interface OnChainStats {
  gamesCreated: number;
  gamesSettled: number;
  gamesCancelled: number;
  volume: bigint;
  feesCollected: bigint;
  payoutTotal: bigint;
  botGames: number;
  botWins: number;
  playerWins: number;
  botPayouts: bigint;
}

function toHex(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  return "";
}

function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string") return BigInt(value);
  return 0n;
}

function decodeAddress(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  try {
    return String(value);
  } catch {
    return null;
  }
}

function decodeGame(raw: unknown): OnChainGame | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  return {
    id: toHex(record.id),
    mode: Number(record.mode ?? 0),
    creator: decodeAddress(record.creator) ?? "",
    opponent: decodeAddress(record.opponent),
    entryAmount: toBigInt(record.entry_amount),
    botStake: toBigInt(record.bot_stake),
    feeBps: Number(record.fee_bps ?? 0),
    status: Number(record.status ?? 0),
    winner: decodeAddress(record.winner),
    playerOneScore: Number(record.player_one_score ?? 0),
    playerTwoScore: Number(record.player_two_score ?? 0),
    createdLedger: Number(record.created_ledger ?? 0),
    expiryLedger: Number(record.expiry_ledger ?? 0),
    settledLedger: Number(record.settled_ledger ?? 0),
    escrow: toBigInt(record.escrow),
    payout: toBigInt(record.payout),
    fee: toBigInt(record.fee),
    resultHash: toHex(record.result_hash),
  };
}

function decodeConfig(raw: unknown): OnChainConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  return {
    admin: decodeAddress(record.admin) ?? "",
    treasury: decodeAddress(record.treasury) ?? "",
    token: decodeAddress(record.token) ?? "",
    feeBps: Number(record.fee_bps ?? 0),
    paused: Boolean(record.paused),
    botEnabled: Boolean(record.bot_enabled),
    maxEntry: toBigInt(record.max_entry),
    maxPayout: toBigInt(record.max_payout),
    minTreasuryBalance: toBigInt(record.min_treasury_balance),
  };
}

export async function getOnChainGame(gameIdHex: string): Promise<OnChainGame | null> {
  const raw = await readContractState("get_game", [scv.bytes32(gameIdHex)]);
  return decodeGame(raw);
}

export async function getOnChainConfig(): Promise<OnChainConfig | null> {
  const raw = await readContractState("get_config", []);
  return decodeConfig(raw);
}

export async function getBotLiquidity(): Promise<bigint> {
  const raw = await readContractState("get_bot_liquidity", []);
  return toBigInt(raw);
}

export async function getAccruedFees(): Promise<bigint> {
  const raw = await readContractState("get_accrued_fees", []);
  return toBigInt(raw);
}

export async function getLockedEscrow(): Promise<bigint> {
  const raw = await readContractState("get_locked_escrow", []);
  return toBigInt(raw);
}

export async function getContractBalance(): Promise<bigint> {
  const raw = await readContractState("get_contract_balance", []);
  return toBigInt(raw);
}

export async function getOnChainStats(): Promise<OnChainStats | null> {
  const raw = await readContractState("get_stats", []);
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  return {
    gamesCreated: Number(record.games_created ?? 0),
    gamesSettled: Number(record.games_settled ?? 0),
    gamesCancelled: Number(record.games_cancelled ?? 0),
    volume: toBigInt(record.volume),
    feesCollected: toBigInt(record.fees_collected),
    payoutTotal: toBigInt(record.payout_total),
    botGames: Number(record.bot_games ?? 0),
    botWins: Number(record.bot_wins ?? 0),
    playerWins: Number(record.player_wins ?? 0),
    botPayouts: toBigInt(record.bot_payouts),
  };
}

// --------------------------------------------------------------- write paths

export function createGameArgs(input: {
  creator: string;
  gameIdHex: string;
  mode: ContractMode;
  entryStroops: number;
  expiryLedger: number;
}): xdr.ScVal[] {
  return [
    scv.address(input.creator),
    scv.bytes32(input.gameIdHex),
    scv.u32(input.mode),
    scv.i128(input.entryStroops),
    scv.u32(input.expiryLedger),
  ];
}

export function joinGameArgs(input: { player: string; gameIdHex: string }): xdr.ScVal[] {
  return [scv.address(input.player), scv.bytes32(input.gameIdHex)];
}

export function settleGameArgs(input: {
  gameIdHex: string;
  winner: string;
  playerOneScore: number;
  playerTwoScore: number;
  resultHashHex: string;
}): xdr.ScVal[] {
  return [
    scv.bytes32(input.gameIdHex),
    scv.address(input.winner),
    scv.i64(input.playerOneScore),
    scv.i64(input.playerTwoScore),
    scv.bytes32(input.resultHashHex),
  ];
}

/** Builds an unsigned invocation for the player's own wallet to sign. */
export async function prepareCreateGame(input: {
  creator: string;
  gameIdHex: string;
  mode: ContractMode;
  entryStroops: number;
  expiryLedger: number;
}) {
  return prepareInvocation({
    publicKey: input.creator,
    method: "create_game",
    args: createGameArgs(input),
  });
}

export async function prepareJoinGame(input: { player: string; gameIdHex: string }) {
  return prepareInvocation({
    publicKey: input.player,
    method: "join_game",
    args: joinGameArgs(input),
  });
}

export async function prepareCancelGame(input: { caller: string; gameIdHex: string }) {
  return prepareInvocation({
    publicKey: input.caller,
    method: "cancel_game",
    args: [scv.address(input.caller), scv.bytes32(input.gameIdHex)],
  });
}

export async function prepareClaimRefund(input: { caller: string; gameIdHex: string }) {
  return prepareInvocation({
    publicKey: input.caller,
    method: "claim_refund",
    args: [scv.bytes32(input.gameIdHex)],
  });
}

export async function prepareFundBotPool(input: { from: string; amountStroops: number }) {
  return prepareInvocation({
    publicKey: input.from,
    method: "fund_bot_pool",
    args: [scv.address(input.from), scv.i128(input.amountStroops)],
  });
}

// Server-signed (settlement authority) operations.

export async function serverStartGame(gameIdHex: string) {
  return invokeWithServerKey({ method: "start_game", args: [scv.bytes32(gameIdHex)] });
}

export async function serverSettleGame(input: {
  gameIdHex: string;
  winner: string;
  playerOneScore: number;
  playerTwoScore: number;
  resultHashHex: string;
}) {
  return invokeWithServerKey({ method: "settle_game", args: settleGameArgs(input) });
}

export async function serverCancelGame(gameIdHex: string) {
  return invokeWithServerKey({
    method: "cancel_game",
    args: [scv.address(getSettlementAddress()), scv.bytes32(gameIdHex)],
  });
}

export async function serverClaimRefund(gameIdHex: string) {
  return invokeWithServerKey({ method: "claim_refund", args: [scv.bytes32(gameIdHex)] });
}

export async function serverWithdrawTreasury(amountStroops: number) {
  return invokeWithServerKey({ method: "withdraw_treasury", args: [scv.i128(amountStroops)] });
}

export async function serverSetPaused(paused: boolean) {
  return invokeWithServerKey({ method: "set_paused", args: [scv.bool(paused)] });
}

export async function serverSetFeeBps(bps: number) {
  return invokeWithServerKey({ method: "set_fee_bps", args: [scv.u32(bps)] });
}

export async function serverSetBotEnabled(enabled: boolean) {
  return invokeWithServerKey({ method: "set_bot_enabled", args: [scv.bool(enabled)] });
}

function getSettlementAddress(): string {
  const address = settlementPublicKey();
  if (!address) throw new Error("No settlement key configured");
  return address;
}
