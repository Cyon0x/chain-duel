import type { SqlDriver } from "./types";
import { STELLAR_TESTNET_XLM } from "../stellar/shared";
import { ensureStellarVerificationSchema } from "./stellar-verification-migrations";

export const STELLAR_SIGNER_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS stellar_signer_state (
    network_id TEXT NOT NULL, address TEXT NOT NULL, lease_owner TEXT, lease_until BIGINT,
    active_intent_id TEXT, PRIMARY KEY(network_id,address))`,
  `CREATE TABLE IF NOT EXISTS stellar_signer_intents (
    id TEXT PRIMARY KEY, network_id TEXT NOT NULL, address TEXT NOT NULL,
    contract_id TEXT NOT NULL, method TEXT NOT NULL, args_hash TEXT NOT NULL,
    signed_xdr TEXT, tx_hash TEXT, max_time BIGINT, status TEXT NOT NULL,
    result_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS stellar_signer_attempts (
    tx_hash TEXT PRIMARY KEY, intent_id TEXT NOT NULL, signed_xdr TEXT NOT NULL,
    max_time BIGINT, status TEXT NOT NULL, archived_at TEXT NOT NULL)`,
];

async function addColumns(database: SqlDriver, table: string, columns: Record<string, string>) {
  const rows = database.dialect === "postgres"
    ? await database.query<{ name: string }>("SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?", [table])
    : await database.query<{ name: string }>(`PRAGMA table_info(${table})`);
  const existing = new Set(rows.map(row => row.name));
  for (const [name, definition] of Object.entries(columns)) {
    if (existing.has(name)) continue;
    await database.execute(`ALTER TABLE ${table} ADD COLUMN ${database.dialect === "postgres" ? "IF NOT EXISTS " : ""}${name} ${definition}`);
  }
}

/** The existing runners replay their idempotent base schema on startup.
 * Context upgrades use their own transaction/version marker, preserving every
 * existing Stellar migration and Arc's independent additive schema. */
export async function ensureStellarFinancialSchema(database: SqlDriver): Promise<void> {
  await database.transaction(async tx => {
    if (tx.dialect === "postgres") await tx.execute("SELECT pg_advisory_xact_lock(73492011)");
    await tx.execute("CREATE TABLE IF NOT EXISTS stellar_schema_versions (version TEXT PRIMARY KEY, installed_at TEXT NOT NULL)");
    const version = "stellar-financial-context-v6";
    if (await tx.one("SELECT version FROM stellar_schema_versions WHERE version = ?", [version])) return;
    const context = { stellar_network: "TEXT NOT NULL DEFAULT 'testnet'", currency: "TEXT NOT NULL DEFAULT 'XLM'" };
    await addColumns(tx, "games", {
      ...context,
      token_contract_id: `TEXT NOT NULL DEFAULT '${STELLAR_TESTNET_XLM}'`,
      protocol_fee_bps: "INTEGER NOT NULL DEFAULT 1000", ecosystem_fee_bps: "INTEGER NOT NULL DEFAULT 0",
      protocol_fee_stroops: "BIGINT NOT NULL DEFAULT 0", ecosystem_fee_stroops: "BIGINT NOT NULL DEFAULT 0",
      start_tx_hash: "TEXT", settlement_started_at: "TEXT",
    });
    for (const table of ["transactions", "matches", "matchmaking_queue", "bot_matches", "treasury_transactions"]) await addColumns(tx, table, context);
    await addColumns(tx, "transactions", { allocation: "TEXT", fee_amount_stroops: "BIGINT NOT NULL DEFAULT 0", prepared_hash: "TEXT" });
    await tx.execute("UPDATE games SET protocol_fee_bps = fee_bps, protocol_fee_stroops = fee_stroops WHERE stellar_network = 'testnet' AND currency = 'XLM'");
    await tx.execute(`CREATE TABLE IF NOT EXISTS stellar_profile_finance (
      user_id TEXT NOT NULL, stellar_network TEXT NOT NULL, currency TEXT NOT NULL,
      total_earned_stroops BIGINT NOT NULL DEFAULT 0, total_wagered_stroops BIGINT NOT NULL DEFAULT 0,
      fees_paid_stroops BIGINT NOT NULL DEFAULT 0, PRIMARY KEY(user_id,stellar_network,currency))`);
    await tx.execute(`INSERT INTO stellar_profile_finance (user_id,stellar_network,currency,total_earned_stroops,total_wagered_stroops,fees_paid_stroops)
      SELECT user_id,'testnet','XLM',total_earned_stroops,total_wagered_stroops,fees_paid_stroops FROM profiles
      WHERE 1 = 1 ON CONFLICT(user_id,stellar_network,currency) DO NOTHING`);
    await tx.execute("CREATE INDEX IF NOT EXISTS stellar_games_network_idx ON games(stellar_network,currency,created_at)");
    await tx.execute("CREATE INDEX IF NOT EXISTS stellar_queue_network_idx ON matchmaking_queue(stellar_network,currency,status,entry_stroops)");
    for (const sql of STELLAR_SIGNER_SCHEMA) await tx.execute(sql);
    await tx.execute(`CREATE TABLE IF NOT EXISTS stellar_fee_withdrawals (
      request_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, allocation TEXT NOT NULL,
      amount_units BIGINT NOT NULL, tx_hash TEXT NOT NULL, booked_at TEXT NOT NULL)`);
    await tx.execute(`CREATE TABLE IF NOT EXISTS stellar_wallet_drafts (
      transaction_id TEXT PRIMARY KEY, unsigned_xdr TEXT NOT NULL,
      tx_hash TEXT NOT NULL, max_time BIGINT NOT NULL)`);
    await tx.execute("INSERT INTO stellar_schema_versions(version,installed_at) VALUES(?,?)", [version, new Date().toISOString()]);
  });
  await ensureStellarVerificationSchema(database);
}
