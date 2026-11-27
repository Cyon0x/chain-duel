import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "@/lib/db/migrations";
import { SqliteDriver, applyDialectTokens } from "@/lib/db/drivers";
import { ensureStellarFinancialSchema } from "@/lib/db/stellar-migrations";
import { createProfile, createUser, createWallet, storeWalletKey, loadWalletKey, findProfile } from "@/lib/db/repositories/identity";
import { createGame, enqueue, findOpponentInQueue } from "@/lib/db/repositories/duel";
import { STELLAR_TESTNET_XLM } from "@/lib/stellar/shared";

afterEach(() => vi.unstubAllEnvs());

describe("additive Stellar financial migration", () => {
  it("preserves pre-migration games, keys, profiles and XLM values while separating Mainnet USDC", async () => {
    const native = new DatabaseSync(":memory:");
    for (const sql of MIGRATIONS) native.exec(applyDialectTokens(sql, "sqlite"));
    const database = new SqliteDriver(native as unknown as ConstructorParameters<typeof SqliteDriver>[0]);
    try {
      const user = await createUser(database, { authProvider: "google" });
      await createProfile(database, { userId: user.id, username: "migration_owner" });
      const wallet = await createWallet(database, { userId: user.id, address: "GBGDTBOXVZ4GIDDRISY5FGXYY7XCWCCK3FRHJHSVFEZMWA3ZZ2HUALTK", provider: "chain-duel-managed", custody: "managed", isPrimary: true, network: "testnet" });
      const sealed = { ciphertext: "opaque-existing-ciphertext", iv: "opaque-existing-iv", authTag: "opaque-existing-tag" };
      await storeWalletKey(database, wallet.id, sealed);
      await database.execute("UPDATE profiles SET total_earned_stroops = ?, total_wagered_stroops = ?, fees_paid_stroops = ? WHERE user_id = ?", [450_000_000, 250_000_000, 25_000_000, user.id]);
      const now = new Date().toISOString();
      await database.execute("INSERT INTO games(id,code,game_type,mode,status,visibility,creator_id,entry_stroops,fee_bps,seed,duration_ms,created_at,expires_at,fee_stroops) VALUES(?,?,'pulse_duel','pvp','settled','public',?,250000000,1000,'legacy',60000,?,?,50000000)", ["legacy-game", "OLDNET", user.id, now, now]);
      const before = await database.one<{ count: number }>("SELECT COUNT(*) AS count FROM wallets");
      await ensureStellarFinancialSchema(database);
      await ensureStellarFinancialSchema(database);
      const old = await database.one("SELECT stellar_network,currency,token_contract_id,entry_stroops,protocol_fee_bps,ecosystem_fee_bps,protocol_fee_stroops FROM games WHERE id = 'legacy-game'");
      expect(old).toEqual({ stellar_network: "testnet", currency: "XLM", token_contract_id: STELLAR_TESTNET_XLM, entry_stroops: 250_000_000, protocol_fee_bps: 1000, ecosystem_fee_bps: 0, protocol_fee_stroops: 50_000_000 });
      expect(await loadWalletKey(database, wallet.id)).toMatchObject({ ciphertext: sealed.ciphertext, iv: sealed.iv, auth_tag: sealed.authTag });
      expect(await database.one("SELECT COUNT(*) AS count FROM wallets")).toEqual(before);
      expect((await findProfile(database, user.id))?.total_earned_stroops).toBe(450_000_000);

      const current = await createGame(database, { code: "NEWNET", mode: "pvp", visibility: "public", creatorId: user.id, entryStroops: 250_000_000, feeBps: 1000, seed: "mainnet", durationMs: 60000, expiresAt: now, escrowState: "none", demo: false, stellarNetwork: "mainnet", currency: "USDC" });
      expect(current).toMatchObject({ stellar_network: "mainnet", currency: "USDC", protocol_fee_bps: 500, ecosystem_fee_bps: 500 });
      await enqueue(database, { userId: user.id, gameType: "pulse_duel", entryStroops: 250_000_000, demo: false, expiresAt: new Date(Date.now() + 60000).toISOString(), stellarNetwork: "testnet", currency: "XLM" });
      expect(await findOpponentInQueue(database, { userId: "other", gameType: "pulse_duel", entryStroops: 250_000_000, demo: false, stellarNetwork: "mainnet" })).toBeNull();
    } finally { await database.close(); }
  });
});
