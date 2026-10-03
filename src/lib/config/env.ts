import { z } from "zod";

/**
 * Central environment access. Everything is read lazily so that a missing
 * optional integration (Google OAuth, a deployed contract, a database) causes
 * a *degraded but honest* state instead of a build or boot failure.
 */

const rawSchema = z.object({
  NODE_ENV: z.string().optional(),
  APP_URL: z.string().optional(),
  VERCEL_URL: z.string().optional(),

  DATABASE_URL: z.string().optional(),
  CHAIN_DUEL_DB_PATH: z.string().optional(),

  SESSION_SECRET: z.string().optional(),
  WALLET_ENCRYPTION_KEY: z.string().optional(),
  CRON_SECRET: z.string().optional(),

  STELLAR_NETWORK: z.enum(["testnet", "futurenet", "mainnet", "local"]).optional(),
  STELLAR_RPC_URL: z.string().optional(),
  STELLAR_HORIZON_URL: z.string().optional(),
  STELLAR_NETWORK_PASSPHRASE: z.string().optional(),
  CHAIN_DUEL_CONTRACT_ID: z.string().optional(),
  CHAIN_DUEL_TOKEN_ID: z.string().optional(),

  ADMIN_WALLET_ADDRESS: z.string().optional(),
  SETTLEMENT_SECRET_KEY: z.string().optional(),
  TREASURY_SECRET_KEY: z.string().optional(),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  X_CLIENT_ID: z.string().optional(),
  X_CLIENT_SECRET: z.string().optional(),

  DEMO_MODE_ENABLED: z.string().optional(),
});

export type RawEnv = z.infer<typeof rawSchema>;

let cached: RawEnv | null = null;

export function rawEnv(): RawEnv {
  if (!cached) {
    cached = rawSchema.parse(process.env as Record<string, string | undefined>);
  }
  return cached;
}

export function isProduction(): boolean {
  return rawEnv().NODE_ENV === "production";
}

/**
 * Session + wallet encryption secrets. In production these MUST be provided.
 * In development we derive a stable local secret so the app is runnable
 * out-of-the-box; the app refuses to boot in production without them.
 */
export function requireSecret(name: "SESSION_SECRET" | "WALLET_ENCRYPTION_KEY"): string {
  const value = rawEnv()[name];
  if (value && value.length >= 32) return value;
  if (value) throw new Error(`${name} must be at least 32 characters`);
  if (isProduction()) {
    throw new Error(`${name} is required in production. Refusing to start with an insecure default.`);
  }
  return `chain-duel-development-only-${name.toLowerCase()}-0000000000`;
}

export function appUrl(): string {
  const env = rawEnv();
  if (env.APP_URL) return env.APP_URL.replace(/\/$/, "");
  if (env.VERCEL_URL) return `https://${env.VERCEL_URL}`;
  return "http://localhost:4310";
}

export function demoModeEnabled(): boolean {
  const value = rawEnv().DEMO_MODE_ENABLED;
  if (value === undefined) return true;
  return value === "true" || value === "1";
}

export function integrationStatus() {
  const env = rawEnv();
  return {
    google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    x: Boolean(env.X_CLIENT_ID && env.X_CLIENT_SECRET),
    contract: Boolean(env.CHAIN_DUEL_CONTRACT_ID),
    settlementKey: Boolean(env.SETTLEMENT_SECRET_KEY || env.TREASURY_SECRET_KEY),
    adminWallet: Boolean(env.ADMIN_WALLET_ADDRESS),
    database: Boolean(env.DATABASE_URL),
    demoMode: demoModeEnabled(),
  };
}
