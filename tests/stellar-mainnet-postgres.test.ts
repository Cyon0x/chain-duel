import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { MIGRATIONS } from "@/lib/db/migrations";
import { applyDialectTokens, toPgPlaceholders } from "@/lib/db/drivers";
import { ensureStellarFinancialSchema } from "@/lib/db/stellar-migrations";
import { ARC_SCHEMA } from "@/lib/arc/db";
import type { SqlDriver } from "@/lib/db/types";
import { STELLAR_DEPLOYMENT_ADMIN, STELLAR_TESTNET_XLM } from "@/lib/stellar/shared";

const url = process.env.CHAIN_DUEL_STELLAR_PG_TEST_URL;

describe.runIf(Boolean(url))("Stellar Mainnet PostgreSQL migration", () => {
  it("preserves existing keys, profiles, games and Arc tables across repeated additive migration and cold starts", async () => {
    const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 15000, ssl: { rejectUnauthorized: false } });
    const client = await pool.connect();
    let started = false;
    try {
      // This suite is deliberately restricted to the known isolated Preview
      // database. Every fixture and temporary schema is rolled back.
      expect((await client.query("SELECT current_database() AS name")).rows[0].name).toBe("chain_duel_multichain_preview");
      await client.query("BEGIN"); started = true;
      const schema = `stellar_migration_${crypto.randomUUID().replaceAll("-","")}`;
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema}`);
      for (const sql of MIGRATIONS) await client.query(applyDialectTokens(sql,"postgres"));
      const timestamp = "2026-11-24T00:00:00Z";
      await client.query("INSERT INTO users(id,auth_provider,provider_account_id,created_at) VALUES('existing-owner','google','existing-google-identity',$1)",[timestamp]);
      await client.query("INSERT INTO profiles(user_id,username,username_lower,total_earned_stroops,total_wagered_stroops,fees_paid_stroops,created_at,updated_at) VALUES('existing-owner','existing_owner','existing_owner',900000000,1000000000,100000000,$1,$1)",[timestamp]);
      await client.query("INSERT INTO wallets(id,user_id,address,provider,custody,network,is_primary,linked_at) VALUES('existing-wallet','existing-owner',$1,'google','managed','testnet',1,$2)",[STELLAR_DEPLOYMENT_ADMIN,timestamp]);
      // Synthetic sealed bytes, never a real seed or encrypted deployment key.
      await client.query("INSERT INTO wallet_keys(wallet_id,ciphertext,iv,auth_tag,created_at) VALUES('existing-wallet','fixture-ciphertext','fixture-iv','fixture-tag',$1)",[timestamp]);
      await client.query("INSERT INTO games(id,code,mode,status,creator_id,entry_stroops,pool_stroops,fee_stroops,seed,created_at,expires_at) VALUES('historical-game','OLDNET','pvp','settled','existing-owner',500000000,1000000000,100000000,'historical-rng-seed',$1,$1)",[timestamp]);
      const before = Object.fromEntries(await Promise.all(["users","profiles","wallets","wallet_keys"].map(async table => [table,(await client.query(`SELECT * FROM ${table}`)).rows])));
      for (const sql of ARC_SCHEMA) await client.query(sql);
      const scoped: SqlDriver = {
        dialect: "postgres",
        query: async <T>(sql: string,params: unknown[] = []) => (await client.query(toPgPlaceholders(sql),params)).rows as T[],
        one: async <T>(sql: string,params: unknown[] = []) => ((await client.query(toPgPlaceholders(sql),params)).rows[0] as T) ?? null,
        execute: async (sql,params = []) => { await client.query(toPgPlaceholders(sql),params); },
        run: async (sql,params = []) => (await client.query(toPgPlaceholders(sql),params)).rowCount ?? 0,
        transaction: fn => fn(scoped),
        close: async () => {},
      };
      await ensureStellarFinancialSchema(scoped);
      await ensureStellarFinancialSchema(scoped);
      for (const sql of MIGRATIONS) await client.query(applyDialectTokens(sql,"postgres"));
      await ensureStellarFinancialSchema(scoped);
      for (const [table,rows] of Object.entries(before)) expect((await client.query(`SELECT * FROM ${table}`)).rows).toEqual(rows);
      const game = (await client.query("SELECT stellar_network,currency,token_contract_id,protocol_fee_bps,ecosystem_fee_bps,protocol_fee_stroops FROM games WHERE id='historical-game'")).rows[0];
      expect(game).toEqual({stellar_network:"testnet",currency:"XLM",token_contract_id:STELLAR_TESTNET_XLM,protocol_fee_bps:1000,ecosystem_fee_bps:0,protocol_fee_stroops:"100000000"});
      expect((await client.query("SELECT total_earned_stroops FROM stellar_profile_finance WHERE user_id='existing-owner' AND stellar_network='testnet'")).rows[0].total_earned_stroops).toBe("900000000");
      expect((await client.query("SELECT COUNT(*)::int AS count FROM stellar_schema_versions")).rows[0].count).toBe(2);
      expect((await client.query("SELECT verification_version,seed_chain_verified,input_deadline_ms FROM games WHERE id='historical-game'")).rows[0]).toEqual({ verification_version: 0, seed_chain_verified: 0, input_deadline_ms: null });
      expect((await client.query("SELECT COUNT(*)::int AS count FROM stellar_player_vaults")).rows[0].count).toBe(0);
      expect((await client.query("SELECT COUNT(*)::int AS count FROM arc_games")).rows[0].count).toBe(0);
    } finally {
      if (started) await client.query("ROLLBACK");
      client.release(); await pool.end();
    }
  },30000);
});
