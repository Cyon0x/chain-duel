/**
 * Chain Duel tests run against an isolated in-memory SQLite database and a
 * fixed set of secrets, so nothing touches a real deployment or network.
 */
const env = process.env as Record<string, string | undefined>;
env.NODE_ENV = env.NODE_ENV ?? "test";
process.env.CHAIN_DUEL_DB_PATH = ":memory:";
process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? "chain-duel-test-session-secret-000000000000";
process.env.WALLET_ENCRYPTION_KEY =
  process.env.WALLET_ENCRYPTION_KEY ?? "chain-duel-test-wallet-key-0000000000000000";
process.env.DEMO_MODE_ENABLED = "true";
// Deliberately no CHAIN_DUEL_CONTRACT_ID: escrow-dependent paths must degrade
// honestly, and tests assert that behaviour.
delete process.env.CHAIN_DUEL_CONTRACT_ID;
delete process.env.SETTLEMENT_SECRET_KEY;
delete process.env.TREASURY_SECRET_KEY;
delete process.env.DATABASE_URL;
