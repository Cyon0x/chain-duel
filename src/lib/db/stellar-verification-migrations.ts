import type { SqlDriver } from "./types";

export async function ensureStellarVerificationSchema(database: SqlDriver): Promise<void> {
  await database.transaction(async tx => {
    if (tx.dialect === "postgres") await tx.execute("SELECT pg_advisory_xact_lock(73492012)");
    const version = "stellar-player-verification-v1";
    if (await tx.one("SELECT version FROM stellar_schema_versions WHERE version = ?", [version])) return;
    const columns = tx.dialect === "postgres"
      ? await tx.query<{ name: string }>("SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'games'")
      : await tx.query<{ name: string }>("PRAGMA table_info(games)");
    const present = new Set(columns.map(row => row.name));
    for (const [name, definition] of Object.entries({ verification_version: "INTEGER NOT NULL DEFAULT 0", seed_chain_verified: "INTEGER NOT NULL DEFAULT 0", input_deadline_ms: "BIGINT" })) {
      if (!present.has(name)) await tx.execute(`ALTER TABLE games ADD COLUMN ${tx.dialect === "postgres" ? "IF NOT EXISTS " : ""}${name} ${definition}`);
    }
    await tx.execute(`CREATE TABLE IF NOT EXISTS stellar_player_vaults (
      wallet_id TEXT NOT NULL, network_id TEXT NOT NULL, version INTEGER NOT NULL,
      status TEXT NOT NULL, public_vault_json TEXT NOT NULL,
      approved_manifest_hash TEXT, verified_ledger BIGINT, created_at TEXT NOT NULL,
      PRIMARY KEY(wallet_id,network_id), FOREIGN KEY(wallet_id) REFERENCES wallets(id))`);
    await tx.execute(`CREATE TABLE IF NOT EXISTS stellar_vault_challenges (
      nonce TEXT PRIMARY KEY, user_id TEXT NOT NULL, network_id TEXT NOT NULL,
      message TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT)`);
    await tx.execute("INSERT INTO stellar_schema_versions(version,installed_at) VALUES(?,?)", [version, new Date().toISOString()]);
  });
}
