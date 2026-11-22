import "server-only";
import { db } from "../db";
import type { SqlDriver } from "../db/types";

// Additive tables only. The original Stellar schema and migration runner are unchanged.
export const ARC_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS circle_users (
    user_id TEXT NOT NULL REFERENCES users(id), app_id TEXT NOT NULL, circle_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL, PRIMARY KEY(user_id, app_id), UNIQUE(circle_user_id, app_id))`,
  `CREATE TABLE IF NOT EXISTS arc_wallets (
    user_id TEXT NOT NULL REFERENCES users(id), network_id TEXT NOT NULL, app_id TEXT NOT NULL,
    circle_user_id TEXT NOT NULL, wallet_id TEXT, address TEXT, provider TEXT NOT NULL DEFAULT 'circle-user-controlled',
    status TEXT NOT NULL DEFAULT 'pending', challenge_id TEXT, idempotency_key TEXT NOT NULL,
    lease_until TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(user_id, network_id, app_id), UNIQUE(wallet_id), UNIQUE(network_id, app_id, address))`,
  `CREATE TABLE IF NOT EXISTS arc_games (
    id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, network_id TEXT NOT NULL, request_key TEXT NOT NULL,
    currency TEXT NOT NULL CHECK(currency = 'USDC'), token_address TEXT NOT NULL, token_decimals INTEGER NOT NULL CHECK(token_decimals = 6),
    contract_address TEXT NOT NULL, contract_game_id TEXT NOT NULL UNIQUE, mode TEXT NOT NULL, game_type TEXT NOT NULL,
    status TEXT NOT NULL, creator_id TEXT NOT NULL REFERENCES users(id), invited_user_id TEXT REFERENCES users(id),
    stake_units TEXT NOT NULL, seed TEXT NOT NULL, duration_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL, started_at TEXT, settlement_status TEXT, settlement_lease_until TEXT,
    winner_id TEXT, result_hash TEXT, settle_tx_hash TEXT, settled_at TEXT, create_block TEXT, UNIQUE(creator_id,network_id,request_key))`,
  `CREATE TABLE IF NOT EXISTS arc_players (
    game_id TEXT NOT NULL REFERENCES arc_games(id), seat INTEGER NOT NULL CHECK(seat IN (1,2)),
    user_id TEXT REFERENCES users(id), address TEXT NOT NULL, score INTEGER, max_combo INTEGER,
    funded INTEGER NOT NULL DEFAULT 0, entry_tx_hash TEXT, result TEXT,
    PRIMARY KEY(game_id, seat), UNIQUE(game_id, user_id))`,
  `CREATE TABLE IF NOT EXISTS arc_queue (
    user_id TEXT NOT NULL REFERENCES users(id), network_id TEXT NOT NULL, currency TEXT NOT NULL CHECK(currency = 'USDC'),
    game_type TEXT NOT NULL, mode TEXT NOT NULL, stake_units TEXT NOT NULL, status TEXT NOT NULL,
    game_id TEXT REFERENCES arc_games(id), created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    PRIMARY KEY(user_id, network_id))`,
  `CREATE TABLE IF NOT EXISTS arc_progress (
    game_id TEXT NOT NULL REFERENCES arc_games(id), user_id TEXT NOT NULL REFERENCES users(id),
    score INTEGER NOT NULL, at_ms INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(game_id,user_id))`,
  `CREATE TABLE IF NOT EXISTS arc_operations (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), network_id TEXT NOT NULL,
    game_id TEXT REFERENCES arc_games(id), action TEXT NOT NULL, wallet_id TEXT NOT NULL, target TEXT NOT NULL,
    calldata TEXT NOT NULL, amount_units TEXT NOT NULL, status TEXT NOT NULL, challenge_id TEXT,
    circle_transaction_id TEXT, tx_hash TEXT, idempotency_key TEXT NOT NULL UNIQUE,
    lease_until TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(user_id, network_id, game_id, action))`,
  `CREATE TABLE IF NOT EXISTS arc_transactions (
    id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), game_id TEXT REFERENCES arc_games(id),
    operation_id TEXT, network_id TEXT NOT NULL, contract_address TEXT, token_address TEXT NOT NULL,
    currency TEXT NOT NULL CHECK(currency = 'USDC'), token_decimals INTEGER NOT NULL CHECK(token_decimals = 6),
    kind TEXT NOT NULL, direction TEXT NOT NULL, amount_units TEXT NOT NULL, status TEXT NOT NULL,
    tx_hash TEXT, created_at TEXT NOT NULL, confirmed_at TEXT, UNIQUE(operation_id, kind, user_id))`,
  `CREATE TABLE IF NOT EXISTS arc_operation_attempts (
    id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES arc_operations(id),
    idempotency_key TEXT NOT NULL UNIQUE, challenge_id TEXT, circle_transaction_id TEXT,
    tx_hash TEXT, status TEXT NOT NULL, error TEXT, archived_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS arc_settlement_attempts (
    game_id TEXT NOT NULL REFERENCES arc_games(id), tx_hash TEXT NOT NULL,
    status TEXT NOT NULL, archived_at TEXT NOT NULL, PRIMARY KEY(game_id,tx_hash))`,
  `CREATE TABLE IF NOT EXISTS arc_signer_state (
    network_id TEXT NOT NULL, address TEXT NOT NULL, next_nonce TEXT NOT NULL DEFAULT '0',
    lease_owner TEXT, lease_until TEXT, PRIMARY KEY(network_id,address))`,
  `CREATE TABLE IF NOT EXISTS arc_authority_transactions (
    id TEXT PRIMARY KEY, network_id TEXT NOT NULL, game_id TEXT NOT NULL REFERENCES arc_games(id),
    action TEXT NOT NULL, address TEXT NOT NULL, target TEXT NOT NULL, calldata TEXT NOT NULL,
    nonce TEXT, signed_transaction TEXT, tx_hash TEXT, status TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(network_id,game_id,action), UNIQUE(network_id,address,nonce))`,
  `CREATE TABLE IF NOT EXISTS arc_authority_attempts (
    tx_hash TEXT PRIMARY KEY, authority_id TEXT NOT NULL REFERENCES arc_authority_transactions(id),
    status TEXT NOT NULL, snapshot TEXT NOT NULL, archived_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS bridge_transfers (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), idempotency_key TEXT NOT NULL,
    source_network TEXT NOT NULL, destination_network TEXT NOT NULL, currency TEXT NOT NULL CHECK(currency = 'USDC'),
    amount_units TEXT NOT NULL, source_address TEXT NOT NULL, destination_address TEXT NOT NULL,
    max_fee_units TEXT NOT NULL DEFAULT '0', message TEXT, attestation TEXT,
    status TEXT NOT NULL, source_tx_hash TEXT, message_hash TEXT, message_nonce TEXT, destination_tx_hash TEXT,
    error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(user_id, idempotency_key))`,
  `CREATE TABLE IF NOT EXISTS bridge_steps (
    id TEXT PRIMARY KEY, bridge_id TEXT NOT NULL REFERENCES bridge_transfers(id), phase TEXT NOT NULL,
    network_id TEXT NOT NULL, target TEXT NOT NULL, calldata TEXT, unsigned_xdr TEXT, signed_xdr TEXT,
    status TEXT NOT NULL, challenge_id TEXT, circle_transaction_id TEXT, tx_hash TEXT,
    idempotency_key TEXT NOT NULL, lease_until TEXT, gas_fee_units TEXT, gas_symbol TEXT,
    gas_decimals INTEGER, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(bridge_id,phase))`,
  `CREATE TABLE IF NOT EXISTS bridge_step_attempts (
    id TEXT PRIMARY KEY, step_id TEXT NOT NULL REFERENCES bridge_steps(id),
    idempotency_key TEXT NOT NULL UNIQUE, snapshot TEXT NOT NULL, archived_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS bridge_active_intent ON bridge_transfers(user_id,source_network,destination_network,amount_units)
    WHERE status NOT IN ('completed','failed')`,
  `CREATE INDEX IF NOT EXISTS arc_games_network_status ON arc_games(network_id, status)`,
  `CREATE INDEX IF NOT EXISTS arc_tx_user_network ON arc_transactions(user_id, network_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS arc_queue_matching ON arc_queue(network_id, currency, game_type, mode, stake_units, status)`,
];
const ready = new WeakMap<SqlDriver, Promise<void>>();
export async function arcDb(): Promise<SqlDriver> {
  const database = await db();
  if (!ready.has(database)) {
    const migration = database.transaction(async (tx) => {
      if (tx.dialect === "postgres") await tx.execute("SELECT pg_advisory_xact_lock(9210427)");
      for (const statement of ARC_SCHEMA) {
        await tx.execute(statement);
      }
    });
    ready.set(database, migration);
    migration.catch(() => ready.delete(database));
  }
  await ready.get(database);
  return database;
}
