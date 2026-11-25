import { bytesHex } from "./pulse-codec";

export interface VerifiedPulseInputs {
  publicKeyHex: string; keyEpoch: number; sequence: number; commitment: string; closed: boolean;
  score: number; maxCombo: number; hits: number; misses: number;
}
export interface VerifiedPulseState {
  version: 1; id: string; seedHex: string; creator: string; opponent: string | null; mode: number; status: number;
  startedAtMs: number; playStartMs: number; endAtMs: number; deadlineMs: number; startedLedger: number; settledLedger: number;
  one: VerifiedPulseInputs; two: VerifiedPulseInputs;
  playerOneScore: number; playerTwoScore: number; playerOneCombo: number; playerTwoCombo: number;
  winner: string | null; payout: string; protocolFee: string; ecosystemFee: string; entryAmount: string; resultHash: string;
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object") throw new Error("Missing independently verified Pulse state.");
  return value as Record<string, unknown>;
};
const hex = (value: unknown): string => value instanceof Uint8Array ? bytesHex(value) : typeof value === "string" ? value : "";
const integer = (value: unknown): number => {
  const result = Number(value); if (!Number.isSafeInteger(result)) throw new Error("Invalid on-chain Pulse integer."); return result;
};
function inputs(value: unknown): VerifiedPulseInputs {
  const input = record(value); const state = record(input.state); const score = record(state.score);
  return { publicKeyHex: hex(input.public_key), keyEpoch: integer(input.key_epoch), sequence: integer(state.events),
    commitment: hex(input.commitment), closed: input.closed === true, score: integer(score.score), maxCombo: integer(score.max_combo), hits: integer(score.hits), misses: integer(score.misses) };
}
export function decodeVerifiedPulseState(raw: unknown): VerifiedPulseState {
  const game = record(raw);
  if (game.verification_version !== 1) throw new Error("This contract does not independently verify Pulse games.");
  const state: VerifiedPulseState = { version: 1, id: hex(game.id), seedHex: hex(game.seed), creator: String(game.creator), opponent: game.opponent ? String(game.opponent) : null,
    mode: integer(game.mode), status: integer(game.status), startedAtMs: integer(game.started_at_ms), playStartMs: integer(game.play_start_ms), endAtMs: integer(game.end_at_ms), deadlineMs: integer(game.input_deadline_ms), startedLedger: integer(game.started_ledger), settledLedger: integer(game.settled_ledger),
    one: inputs(game.inputs_one), two: inputs(game.inputs_two), playerOneScore: integer(game.player_one_score), playerTwoScore: integer(game.player_two_score),
    playerOneCombo: integer(game.player_one_combo), playerTwoCombo: integer(game.player_two_combo), winner: game.winner ? String(game.winner) : null,
    payout: String(game.payout), protocolFee: String(game.protocol_fee), ecosystemFee: String(game.ecosystem_fee), entryAmount: String(game.entry_amount), resultHash: hex(game.result_hash) };
  if (![state.id, state.seedHex, state.one.publicKeyHex, state.two.publicKeyHex, state.one.commitment, state.two.commitment, state.resultHash].every(value => /^[0-9a-f]{64}$/.test(value))) throw new Error("Malformed on-chain Pulse commitments.");
  if (state.status === 2 || state.status === 4) {
    if (state.playStartMs !== state.startedAtMs + 3200 || state.endAtMs !== state.playStartMs + 60000 || state.deadlineMs !== state.startedAtMs + 80000) throw new Error("The contract game clock does not match the approved rules.");
  }
  return state;
}
