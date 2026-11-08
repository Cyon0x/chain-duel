import { describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createGame, findGameByCode } from "@/lib/db/repositories/duel";
import { gameEscrowContractId } from "@/lib/services/escrow";
import { joinQueue } from "@/lib/services/matchmaking";
import { signInWithWallet } from "@/lib/services/accounts";
import { Keypair } from "@stellar/stellar-sdk";

const original = "CBBDWEWBBQVQXNYUJ4FA6C2CXXUVDAJSNUOVPZNKTQWK5P2EON7KEGMZ";
const replacement = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
vi.mock("@/lib/config/stellar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config/stellar")>();
  return { ...actual, legacyContractId: () => original, contractId: () => replacement };
});
vi.mock("@/lib/services/escrow", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/services/escrow")>(),
  onChainEscrowAvailable: () => true,
}));

describe("escrow rollout preserves old games", () => {
  it("routes an existing unbound game to the original contract", async () => {
    expect(await gameEscrowContractId("existing-game")).toBe(original);
  });
  it("persists the new game's escrow and keeps the old contract untouched", async () => {
    const game = await createGame(await db(), {
      code: "NEWESC", mode: "private", visibility: "private", creatorId: "test-player", entryStroops: 100_000_000_000,
      feeBps: 1000, seed: "escrow-routing", durationMs: 60_000, expiresAt: new Date(Date.now() + 60_000).toISOString(), escrowState: "none",
      demo: false, contractGameId: "a1".repeat(32), escrowContractId: replacement,
    });
    expect(await gameEscrowContractId(game.id)).toBe(replacement);
    expect(game.entry_stroops).toBe(100_000_000_000);
    expect(await gameEscrowContractId("existing-game")).toBe(original);
  });
  it("binds maximum-stake random matchmaking to the new escrow", async () => {
    const alpha = await signInWithWallet(Keypair.random().publicKey());
    const beta = await signInWithWallet(Keypair.random().publicKey());
    const entryStroops = 100_000_000_000;
    await joinQueue({ userId: alpha.userId, entryStroops, demo: false });
    const matched = await joinQueue({ userId: beta.userId, entryStroops, demo: false });
    expect(matched.status).toBe("matched");
    expect(matched.entryStroops).toBe(entryStroops);
    expect(await gameEscrowContractId(matched.gameId!)).toBe(replacement);
  });
  it("rolls back game creation when its contract binding fails", async () => {
    const database = await db();
    const execute = database.execute.bind(database);
    const spy = vi.spyOn(database, "execute").mockImplementation((sql, params) => {
      if (sql.startsWith("INSERT INTO game_escrow_contracts")) throw new Error("binding failed");
      return execute(sql, params);
    });
    try {
      await expect(createGame(database, {
        code: "BADESC", mode: "private", visibility: "private", creatorId: "test-player", entryStroops: 250_000_000,
        feeBps: 1000, seed: "rollback", durationMs: 60_000, expiresAt: new Date().toISOString(), escrowState: "none",
        demo: false, escrowContractId: replacement,
      })).rejects.toThrow("binding failed");
      expect(await findGameByCode(database, "BADESC")).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
