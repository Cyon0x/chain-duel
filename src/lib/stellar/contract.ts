import "server-only";
import { xdr } from "@stellar/stellar-sdk";
import { contractId, stellarNetwork } from "../config/stellar";
import type { StellarNetworkId } from "./shared";
import { stellarVerificationEnabled } from "../config/stellar-verification";
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

export function contractConfigured(networkId?: StellarNetworkId): boolean {
  try {
    return contractId(networkId) !== null;
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
  protocolFeeBps?: number;
  ecosystemFeeBps?: number;
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
  protocolFee?: bigint;
  ecosystemFee?: bigint;
  resultHash: string;
}

export interface OnChainConfig {
  admin: string;
  treasury: string;
  token: string;
  feeBps: number;
  protocolFeeBps?: number;
  ecosystemFeeBps?: number;
  protocolFeeRecipient?: string;
  ecosystemFeeRecipient?: string;
  ecosystemBeneficiary?: string;
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
    protocolFeeBps: Number(record.protocol_fee_bps ?? record.fee_bps ?? 0),
    ecosystemFeeBps: Number(record.ecosystem_fee_bps ?? 0),
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
    protocolFee: toBigInt(record.protocol_fee ?? record.fee),
    ecosystemFee: toBigInt(record.ecosystem_fee),
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
    protocolFeeBps: Number(record.protocol_fee_bps ?? record.fee_bps ?? 0),
    ecosystemFeeBps: Number(record.ecosystem_fee_bps ?? 0),
    protocolFeeRecipient: decodeAddress(record.protocol_fee_recipient) ?? decodeAddress(record.treasury) ?? "",
    ecosystemFeeRecipient: decodeAddress(record.ecosystem_fee_recipient) ?? "",
    ecosystemBeneficiary: decodeAddress(record.ecosystem_beneficiary) ?? "",
    paused: Boolean(record.paused),
    botEnabled: Boolean(record.bot_enabled),
    maxEntry: toBigInt(record.max_entry),
    maxPayout: toBigInt(record.max_payout),
    minTreasuryBalance: toBigInt(record.min_treasury_balance),
  };
}

export async function getOnChainGame(gameIdHex: string, escrowContractId?: string, networkId?: StellarNetworkId): Promise<OnChainGame | null> {
  const raw = await readContractState("get_game", [scv.bytes32(gameIdHex)], escrowContractId, networkId);
  return decodeGame(raw);
}

export async function getOnChainConfig(escrowContractId?: string, networkId?: StellarNetworkId): Promise<OnChainConfig | null> {
  const raw = await readContractState("get_config", [], escrowContractId, networkId);
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

export async function getProtocolFees(): Promise<bigint> {
  return stellarNetwork().id === "mainnet" || stellarVerificationEnabled() ? toBigInt(await readContractState("get_protocol_fees", [])) : getAccruedFees();
}

export async function getEcosystemFees(): Promise<bigint> {
  return stellarNetwork().id === "mainnet" || stellarVerificationEnabled() ? toBigInt(await readContractState("get_ecosystem_fees", [])) : 0n;
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
  networkId?: StellarNetworkId;
  gameIdHex: string;
  winner: string;
  playerOneScore: number;
  playerTwoScore: number;
  playerOneCombo?: number;
  playerTwoCombo?: number;
  resultHashHex: string;
}): xdr.ScVal[] {
  return [
    scv.bytes32(input.gameIdHex),
    scv.address(input.winner),
    scv.i64(input.playerOneScore),
    scv.i64(input.playerTwoScore),
    ...(stellarNetwork(input.networkId).id === "mainnet" ? [scv.i64(input.playerOneCombo ?? 0), scv.i64(input.playerTwoCombo ?? 0)] : []),
    scv.bytes32(input.resultHashHex),
  ];
}

/** Builds an unsigned invocation for the player's own wallet to sign. */
export async function prepareCreateGame(input: {
  networkId?: StellarNetworkId;
  escrowContractId?: string;
  creator: string;
  gameIdHex: string;
  mode: ContractMode;
  entryStroops: number;
  expiryLedger: number;
}) {
  return prepareInvocation({
    publicKey: input.creator,
    networkId: input.networkId,
    method: "create_game",
    args: createGameArgs(input),
    escrowContractId: input.escrowContractId,
  });
}

export async function prepareJoinGame(input: { player: string; gameIdHex: string; escrowContractId?: string; networkId?: StellarNetworkId }) {
  return prepareInvocation({
    publicKey: input.player,
    networkId: input.networkId,
    method: "join_game",
    args: joinGameArgs(input),
    escrowContractId: input.escrowContractId,
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

export async function serverStartGame(gameIdHex: string, escrowContractId?: string, networkId?: StellarNetworkId) {
  return invokeWithServerKey({ method: "start_game", args: [scv.bytes32(gameIdHex)], escrowContractId, networkId });
}

export async function serverSettleGame(input: {
  networkId?: StellarNetworkId;
  escrowContractId?: string;
  gameIdHex: string;
  winner: string;
  playerOneScore: number;
  playerTwoScore: number;
  playerOneCombo?: number;
  playerTwoCombo?: number;
  resultHashHex: string;
}) {
  return invokeWithServerKey({ method: "settle_game", args: settleGameArgs(input), escrowContractId: input.escrowContractId, networkId: input.networkId });
}

export async function serverCancelGame(gameIdHex: string, escrowContractId?: string, networkId?: StellarNetworkId) {
  return invokeWithServerKey({
    method: "cancel_game",
    args: [scv.address(getSettlementAddress()), scv.bytes32(gameIdHex)],
    escrowContractId,
    networkId,
  });
}

export async function serverClaimRefund(gameIdHex: string, escrowContractId?: string, networkId?: StellarNetworkId) {
  return invokeWithServerKey({ method: "claim_refund", args: [scv.bytes32(gameIdHex)], escrowContractId, networkId });
}

export async function serverWithdrawFees(input: { kind: "protocol" | "ecosystem"; amountStroops: number; withdrawalId: string }) {
  return invokeWithServerKey({ method: input.kind === "protocol" ? "withdraw_protocol_fees" : "withdraw_ecosystem_fees", args: [scv.bytes32(input.withdrawalId), scv.i128(input.amountStroops)], intentId: `stellar-fee:${input.kind}:${input.withdrawalId}` });
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
