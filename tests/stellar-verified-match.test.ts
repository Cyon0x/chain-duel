import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrKey } from "@stellar/stellar-sdk";
import { STELLAR_DEPLOYMENT_ADMIN, STELLAR_TESTNET_USDC } from "@/lib/stellar/shared";
import type { VerifiedPulseState } from "@/lib/stellar/pulse-state";

const chain = vi.hoisted(() => ({ state: vi.fn(), settle: vi.fn(), receipt: vi.fn(), inputs: vi.fn(), inputReceipt: vi.fn(), startReceipt: vi.fn() }));
vi.mock("@/lib/stellar/verified-contract", async () => ({ ...await vi.importActual<typeof import("@/lib/stellar/verified-contract")>("@/lib/stellar/verified-contract"), verifiedPulseState: chain.state, settleVerifiedGame: chain.settle, verifiedSettlementReceipt: chain.receipt, relayVerifiedInputs: chain.inputs, verifiedInputReceipt: chain.inputReceipt, verifiedStartReceipt: chain.startReceipt }));
const p1 = "GBGDTBOXVZ4GIDDRISY5FGXYY7XCWCCK3FRHJHSVFEZMWA3ZZ2HUALTK";
const p2 = StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(41));
const contract = StrKey.encodeContract(new Uint8Array(32).fill(42)); const hash = "91".repeat(32);
beforeEach(async () => {
  if (globalThis.__chainDuelDb) await (await globalThis.__chainDuelDb).driver.close(); delete globalThis.__chainDuelDb;
  vi.resetModules(); vi.clearAllMocks(); vi.stubEnv("STELLAR_NETWORK", "testnet"); vi.stubEnv("STELLAR_PLAYER_SIGNING_MODE", "client");
});
afterEach(() => vi.unstubAllEnvs());
async function fixture(mode: "pvp" | "bot" = "pvp") {
  const database = await (await import("@/lib/db")).db(); const identity = await import("@/lib/db/repositories/identity"); const duel = await import("@/lib/db/repositories/duel");
  const users = [];
  for (const [index, address] of [p1, p2].entries()) {
    const user = await identity.createUser(database, { authProvider: "stellar", primaryWallet: address });
    await identity.createProfile(database, { userId: user.id, username: `verified_${index}` });
    await identity.createWallet(database, { userId: user.id, address, provider: "freighter", custody: "external", network: "testnet", isPrimary: true }); users.push(user);
  }
  const game = await duel.createGame(database, { code: "VRFY01", mode, visibility: "public", creatorId: users[0].id, entryStroops: 500000000, feeBps: 1000, seed: "backend-seed-should-not-decide", durationMs: 60000,
    expiresAt: new Date(Date.now() + 300000).toISOString(), escrowState: "onchain", demo: false, contractGameId: "72".repeat(32), escrowContractId: contract,
    stellarNetwork: "testnet", currency: "USDC", tokenContractId: STELLAR_TESTNET_USDC, verificationVersion: 1 });
  await duel.addGamePlayer(database, { gameId: game.id, userId: users[0].id, address: p1, seat: 1 });
  await duel.addGamePlayer(database, { gameId: game.id, userId: mode === "bot" ? "bot:vex-7" : users[1].id, address: mode === "bot" ? null : p2, seat: 2, isBot: mode === "bot" });
  await duel.updateGame(database, game.id, { status: "active", start_tx_hash: hash, started_at: new Date(Date.now() - 100000).toISOString(), create_tx_hash: hash, join_tx_hash: hash });
  const inputs = { publicKeyHex: "33".repeat(32), keyEpoch: 0, sequence: 0, commitment: "00".repeat(32), closed: true, score: 0, maxCombo: 0, hits: 0, misses: 0 };
  const state: VerifiedPulseState = { version: 1, id: game.contract_game_id!, seedHex: "24".repeat(32), creator: p1, opponent: mode === "bot" ? null : p2, mode: mode === "bot" ? 1 : 0,
    status: 4, startedAtMs: Date.now() - 100000, playStartMs: Date.now() - 96800, endAtMs: Date.now() - 36800, deadlineMs: Date.now() - 20000, startedLedger: 99, settledLedger: 100,
    one: { ...inputs, closed: false, score: 0 }, two: { ...inputs, score: 100, maxCombo: 3, hits: 10 }, playerOneScore: 0, playerTwoScore: 100, playerOneCombo: 0, playerTwoCombo: 3,
    winner: mode === "bot" ? STELLAR_DEPLOYMENT_ADMIN : p2, payout: "900000000", protocolFee: "50000000", ecosystemFee: "50000000", entryAmount: "500000000", resultHash: "31".repeat(32) };
  chain.state.mockResolvedValue(state); chain.receipt.mockResolvedValue(hash); chain.settle.mockResolvedValue({ hash, ledger: 100 }); chain.inputs.mockResolvedValue({ hash }); chain.inputReceipt.mockResolvedValue(undefined);
  return { database, users, game, duel, identity, state };
}
describe("independently verified Pulse bookkeeping", () => {
  it("ignores fabricated backend scores and derives payout/history from the actual contract result", async () => {
    const { database, users, game, duel, identity } = await fixture();
    await duel.recordPlayerResult(database, game.id, users[0].id, { score: 9999999, maxCombo: 999999, hits: 1000, misses: 0, result: "finished" });
    const match = await import("@/lib/services/match"); const result = await match.settleMatch(game.id);
    expect(result).toMatchObject({ winner_id: users[1].id, player_one_score: 0, player_two_score: 100, payout_stroops: 900000000, protocol_fee_stroops: 50000000, ecosystem_fee_stroops: 50000000, result_hash: "31".repeat(32), settle_tx_hash: hash });
    expect(await database.one("SELECT address,amount_stroops,currency FROM transactions WHERE game_id = ? AND kind = 'payout'", [game.id])).toEqual({ address: p2, amount_stroops: 900000000, currency: "USDC" });
    await match.settleMatch(game.id);
    expect(chain.receipt).toHaveBeenCalledTimes(1);
    expect((await database.one<{ count: number }>("SELECT COUNT(*) AS count FROM transactions WHERE game_id = ? AND kind = 'payout'", [game.id]))?.count).toBe(1);
    expect((await identity.findProfile(database, users[1].id))?.wins).toBe(1);
  });
  it("settles without supplying any score, winner, combo, bot result or fee to the contract", async () => {
    const { game, state } = await fixture(); chain.state.mockResolvedValueOnce({ ...state, status: 2, settledLedger: 0 });
    await (await import("@/lib/services/match")).settleMatch(game.id);
    expect(chain.settle).toHaveBeenCalledTimes(1); expect(chain.settle.mock.calls[0]).toHaveLength(1);
    expect(chain.settle.mock.calls[0][0].id).toBe(game.id);
  });
  it("rejects a plain fabricated score or another player's authorization", async () => {
    const { game, users } = await fixture(); const match = await import("@/lib/services/match");
    const payload = { seat: 1, hits: [], misses: [], clientScore: 99999999 };
    await expect(match.submitResult({ gameId: game.id, userId: users[0].id, payload })).rejects.toMatchObject({ code: "verified_input_required" });
    await expect(match.submitResult({ gameId: game.id, userId: users[0].id, payload, signedInputs: { version: 1, player: p2, sequence: 0, closed: true, transcriptHex: "", signatureHex: "00".repeat(64) } })).rejects.toMatchObject({ code: "input_player_mismatch" });
    expect(chain.inputs).not.toHaveBeenCalled();
  });
  it("records an independently confirmed input receipt and ignores the submitted score", async () => {
    const { game, users } = await fixture();
    const result = await (await import("@/lib/services/match")).submitResult({ gameId: game.id, userId: users[0].id, verifiedReceiptHash: hash, payload: { seat: 1, hits: [], misses: [], clientScore: 99999999 } });
    expect(chain.inputReceipt).toHaveBeenCalledWith(expect.objectContaining({ id: game.id }), p1, hash); expect(result.score).toBe(0); expect(result.settled).toBe(true);
  });
  it.each(["winner", "protocolFee", "ecosystemFee", "payout", "creator"])("rejects inconsistent on-chain %s without awarding local winnings or statistics", async field => {
    const { game, state, database, users, identity } = await fixture();
    chain.state.mockResolvedValue({ ...state, [field]: field === "creator" || field === "winner" ? STELLAR_DEPLOYMENT_ADMIN : "1" });
    await expect((await import("@/lib/services/match")).settleMatch(game.id)).rejects.toThrow();
    expect((await database.one<{ count: number }>("SELECT COUNT(*) AS count FROM transactions WHERE game_id = ? AND kind = 'payout'", [game.id]))?.count).toBe(0);
    expect((await identity.findProfile(database, users[1].id))?.wins).toBe(0);
  });
  it("uses the contract's bot result without accepting a backend VEX-7 override", async () => {
    const { game, database, users, duel } = await fixture("bot");
    await duel.recordPlayerResult(database, game.id, users[0].id, { score: 99999999, maxCombo: 99999, hits: 1000, misses: 0, result: "finished" });
    const result = await (await import("@/lib/services/match")).settleMatch(game.id);
    expect(result).toMatchObject({ winner_id: null, player_two_score: 100, player_one_score: 0, bot_outcome: "loss" });
    expect(await database.one("SELECT * FROM transactions WHERE game_id = ? AND kind = 'payout'", [game.id])).toBeNull();
  });
});
