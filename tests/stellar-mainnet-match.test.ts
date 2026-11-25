import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrKey } from "@stellar/stellar-sdk";
import { STELLAR_DEPLOYMENT_ADMIN, STELLAR_MAINNET_USDC, stellarPoolSplit } from "@/lib/stellar/shared";

const mock = vi.hoisted(() => ({ begin: vi.fn(), settle: vi.fn(), game: vi.fn(), config: vi.fn() }));
vi.mock("@/lib/services/escrow", async () => ({ ...await vi.importActual<typeof import("@/lib/services/escrow")>("@/lib/services/escrow"), beginOnChainGame: mock.begin, settleOnChain: mock.settle }));
vi.mock("@/lib/stellar/contract", async () => ({ ...await vi.importActual<typeof import("@/lib/stellar/contract")>("@/lib/stellar/contract"), getOnChainGame: mock.game, getOnChainConfig: mock.config }));

// Unfunded public-address fixtures and mocked receipts, never live transactions.
const p1 = "GBGDTBOXVZ4GIDDRISY5FGXYY7XCWCCK3FRHJHSVFEZMWA3ZZ2HUALTK";
const p2 = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2));
const changedWallet = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 3));
const contract = StrKey.encodeContract(Buffer.alloc(32, 42));
const txHash = "f1".repeat(32);

beforeEach(async () => {
  if (globalThis.__chainDuelDb) await (await globalThis.__chainDuelDb).driver.close();
  delete globalThis.__chainDuelDb;
  vi.resetModules(); vi.clearAllMocks(); vi.stubEnv("STELLAR_NETWORK", "mainnet");
  mock.begin.mockResolvedValue(txHash);
  mock.config.mockResolvedValue({ treasury: STELLAR_DEPLOYMENT_ADMIN, admin: STELLAR_DEPLOYMENT_ADMIN, token: STELLAR_MAINNET_USDC });
});
afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  const { db } = await import("@/lib/db");
  const identity = await import("@/lib/db/repositories/identity");
  const duel = await import("@/lib/db/repositories/duel");
  const database = await db();
  const users = [];
  for (const [index,address] of [p1,p2].entries()) {
    const user = await identity.createUser(database, { authProvider: "stellar" });
    await identity.createProfile(database, { userId: user.id, username: `match_${index}` });
    await identity.createWallet(database, { userId: user.id, address, custody: "external", provider: "freighter", network: "testnet", isPrimary: true });
    users.push(user);
  }
  const game = await duel.createGame(database, { code: "MAIN01", mode: "pvp", visibility: "public", creatorId: users[0].id, entryStroops: 250_000_000, feeBps: 1000, seed: "verified-mainnet-fixture", durationMs: 60000, expiresAt: new Date(Date.now()+300000).toISOString(), escrowState: "onchain", demo: false, stellarNetwork: "mainnet", currency: "USDC", escrowContractId: contract, contractGameId: "ab".repeat(32) });
  for (const [index,user] of users.entries()) await duel.addGamePlayer(database, { gameId: game.id, userId: user.id, seat: index+1, address: index === 0 ? p1 : p2 });
  await duel.updateGame(database, game.id, { status: "joined", opponent_id: users[1].id, create_tx_hash: txHash, join_tx_hash: txHash });
  mock.settle.mockImplementation(async (input: { game: { contract_game_id: string; entry_stroops: number }; winnerAddress: string; playerOneScore: number; playerTwoScore: number; resultHashHex: string }) => {
    const split = stellarPoolSplit(input.game.entry_stroops*2,500,500);
    mock.game.mockResolvedValue({ id: input.game.contract_game_id, status: 4, creator: p1, entryAmount: BigInt(input.game.entry_stroops), winner: input.winnerAddress, payout: BigInt(split.payout), protocolFee: BigInt(split.protocol), ecosystemFee: BigInt(split.ecosystem), resultHash: input.resultHashHex, playerOneScore: input.playerOneScore, playerTwoScore: input.playerTwoScore });
    return { txHash, ledger: 1001, mode: "onchain" };
  });
  return { database, users, game, duel, identity };
}

describe("Mainnet match lifecycle", () => {
  it("publishes an active match and starts its full timer only after chain confirmation", async () => {
    const { game,users } = await fixture();
    const { startMatch,loadGameView } = await import("@/lib/services/match");
    mock.begin.mockImplementation(async () => {
      const pending = await loadGameView(game.id);
      expect(pending?.game.status).toBe("joined");
      expect(pending?.startAtMs).toBeNull();
      return txHash;
    });
    const before = Date.now();
    const active = await startMatch({ gameId: game.id, userId: users[0].id });
    expect(active.status).toBe("active");
    expect(active.start_tx_hash).toBe(txHash);
    expect(Date.parse(active.started_at!)).toBeGreaterThanOrEqual(before);
    await startMatch({ gameId: game.id, userId: users[1].id });
    expect(mock.begin).toHaveBeenCalledTimes(1);
  });

  it("recovers an interrupted start before letting gameplay begin", async () => {
    const { game,users,duel,database } = await fixture();
    await duel.updateGame(database,game.id,{status:"active",started_at:null,start_tx_hash:null});
    const { startMatch } = await import("@/lib/services/match");
    expect((await startMatch({ gameId: game.id, userId: users[0].id })).start_tx_hash).toBe(txHash);
  });

  it("pays the original depositor and books both fee allocations only once", async () => {
    const { game,users,duel,database,identity } = await fixture();
    await duel.updateGame(database,game.id,{status:"active",start_tx_hash:txHash,started_at:new Date(Date.now()-500000).toISOString()});
    await duel.recordPlayerResult(database,game.id,users[0].id,{score:100,maxCombo:5,hits:10,misses:0,result:"finished"});
    await duel.recordPlayerResult(database,game.id,users[1].id,{score:10,maxCombo:1,hits:1,misses:0,result:"finished"});
    await database.execute("UPDATE wallets SET is_primary = 0 WHERE user_id = ?",[users[0].id]);
    await identity.createWallet(database,{userId:users[0].id,address:changedWallet,custody:"external",provider:"freighter",network:"mainnet",isPrimary:true});
    const { settleMatch } = await import("@/lib/services/match");
    await settleMatch(game.id); await settleMatch(game.id);
    expect(mock.settle).toHaveBeenCalledTimes(1);
    expect(mock.settle.mock.calls[0][0].winnerAddress).toBe(p1);
    expect(await database.one("SELECT amount_stroops,address,currency,stellar_network FROM transactions WHERE game_id = ? AND kind = 'payout'",[game.id])).toEqual({amount_stroops:450_000_000,address:p1,currency:"USDC",stellar_network:"mainnet"});
    const fees=await database.query<{metadata:string;amount_stroops:number}>("SELECT metadata,amount_stroops FROM treasury_transactions WHERE game_id = ? AND kind = 'fee_accrual'",[game.id]);
    expect(fees).toHaveLength(2);
    expect(fees.map(row=>JSON.parse(row.metadata).allocation).sort()).toEqual(["ecosystem","protocol"]);
    expect(fees.reduce((sum,row)=>sum+row.amount_stroops,0)).toBe(50_000_000);
    expect((await identity.findProfile(database,users[0].id))?.total_earned_stroops).toBe(0);
    expect((await database.one<{total_earned_stroops:number}>("SELECT total_earned_stroops FROM stellar_profile_finance WHERE user_id = ? AND currency = 'USDC'",[users[0].id]))?.total_earned_stroops).toBe(450_000_000);
  });

  it("a stalled submission can be recovered after its signing lease expires", async () => {
    const { game,users,duel,database } = await fixture();
    await duel.updateGame(database,game.id,{status:"finished",start_tx_hash:txHash,started_at:new Date(Date.now()-600000).toISOString(),settlement_status:"submitting",settlement_started_at:new Date(Date.now()-301000).toISOString()});
    for (const [index,user] of users.entries()) await duel.recordPlayerResult(database,game.id,user.id,{score:index===0?100:10,maxCombo:1,hits:1,misses:0,result:"finished"});
    const { ensureSettlementForExpiredMatches } = await import("@/lib/services/match");
    expect(await ensureSettlementForExpiredMatches()).toBe(1);
    expect((await duel.findGameById(database,game.id))?.status).toBe("settled");
  });
});
