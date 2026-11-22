import { describe, it, expect } from "vitest";
import { Pool } from "pg";
import { MIGRATIONS } from "@/lib/db/migrations";
import { applyDialectTokens } from "@/lib/db/drivers";
import { ARC_SCHEMA } from "@/lib/arc/db";

const url = process.env.CHAIN_DUEL_ARC_PG_TEST_URL;
describe.runIf(Boolean(url))("Arc PostgreSQL migration compatibility", () => {
  it("preserves original startup migrations and records after Arc schema initialization", async () => {
    const pool = new Pool({ connectionString: url, max: 1, ssl: { rejectUnauthorized: false } });
    const client = await pool.connect();
    try {
      expect((await client.query("SELECT current_database() AS name")).rows[0].name).toBe(
        "chain_duel_multichain_preview",
      );
      await client.query("BEGIN");
      const schema = "arc_regression_" + crypto.randomUUID().replaceAll("-", "");
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema}`);
      for (const sql of MIGRATIONS) await client.query(applyDialectTokens(sql, "postgres"));
      await client.query(
        "INSERT INTO users(id,auth_provider,provider_account_id,created_at) VALUES('protected-account','google','verified-identity','2026-11-22T00:00:00Z')",
      );
      const before = (await client.query("SELECT * FROM users WHERE id='protected-account'")).rows[0];
      for (const sql of ARC_SCHEMA) await client.query(sql);
      // Existing Stellar cold starts always re-run these migrations, including ALTER COLUMN TYPE.
      for (const sql of MIGRATIONS) await client.query(applyDialectTokens(sql, "postgres"));
      expect((await client.query("SELECT * FROM users WHERE id='protected-account'")).rows[0]).toEqual(
        before,
      );
      expect((await client.query("SELECT COUNT(*)::int AS count FROM arc_games")).rows[0].count).toBe(0);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  });
});
