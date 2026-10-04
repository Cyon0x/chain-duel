import { rawEnv, isProduction } from "../config/env";
import { ChainDuelError } from "../services/errors";
import { MIGRATIONS } from "./migrations";
import { PostgresDriver, SqliteDriver } from "./drivers";
import type { PersistenceMode, SqlDriver } from "./types";

export type * from "./types";

/**
 * Raised when durable persistence is genuinely unavailable. Production never
 * falls back to ephemeral storage, so the API can return an honest 503 instead
 * of accepting money or accounts it cannot keep.
 */
export class DatabaseUnavailableError extends ChainDuelError {
  constructor(message = "Chain Duel is temporarily unavailable. Please try again.") {
    super(message, "database_unavailable", 503);
    this.name = "DatabaseUnavailableError";
  }
}

interface DatabaseState {
  driver: SqlDriver;
  mode: PersistenceMode;
}

declare global {
  var __chainDuelDb: Promise<DatabaseState> | undefined;
}

async function createDatabase(): Promise<DatabaseState> {
  const env = rawEnv();

  if (env.DATABASE_URL) {
    try {
      const driver = await PostgresDriver.open(env.DATABASE_URL, MIGRATIONS);
      return { driver, mode: "postgres" };
    } catch (error) {
      console.error(
        "[chain-duel] Postgres is unreachable:",
        error instanceof Error ? error.message : error,
      );
      throw new DatabaseUnavailableError();
    }
  }

  // Production must never silently degrade to in-memory SQLite: an account or a
  // paid duel that cannot be persisted must not be created in the first place.
  if (isProduction() && !env.CHAIN_DUEL_DB_PATH) {
    console.error("[chain-duel] DATABASE_URL is not configured in production.");
    throw new DatabaseUnavailableError();
  }

  const path = env.CHAIN_DUEL_DB_PATH ?? "./chain-duel.db";
  try {
    const driver = await SqliteDriver.open(path, MIGRATIONS);
    return { driver, mode: path === ":memory:" ? "sqlite-memory" : "sqlite-file" };
  } catch (error) {
    console.error("[chain-duel] Local database is unavailable:", error);
    throw new DatabaseUnavailableError();
  }
}

export function getDatabase(): Promise<DatabaseState> {
  if (!globalThis.__chainDuelDb) {
    globalThis.__chainDuelDb = createDatabase().catch((error) => {
      globalThis.__chainDuelDb = undefined;
      throw error;
    });
  }
  return globalThis.__chainDuelDb;
}

export async function db(): Promise<SqlDriver> {
  return (await getDatabase()).driver;
}

export async function persistenceMode(): Promise<PersistenceMode> {
  return (await getDatabase()).mode;
}

/**
 * Never throws. Use this on paths that must render even when the database is
 * down (layout, health checks) so the app can degrade honestly.
 */
export async function persistenceStatus(): Promise<{ mode: PersistenceMode; available: boolean }> {
  try {
    const state = await getDatabase();
    return { mode: state.mode, available: true };
  } catch {
    return { mode: "unavailable", available: false };
  }
}

export async function isDurablePersistence(): Promise<boolean> {
  const mode = await persistenceMode();
  return mode === "postgres" || mode === "sqlite-file";
}

export function newId(prefix?: string): string {
  const id = crypto.randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function jsonColumn(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
