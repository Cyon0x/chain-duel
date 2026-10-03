import { rawEnv, isProduction } from "../config/env";
import { MIGRATIONS } from "./migrations";
import { PostgresDriver, SqliteDriver } from "./drivers";
import type { PersistenceMode, SqlDriver } from "./types";

export type * from "./types";

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
    const driver = await PostgresDriver.open(env.DATABASE_URL, MIGRATIONS);
    return { driver, mode: "postgres" };
  }
  const path = env.CHAIN_DUEL_DB_PATH ?? (isProduction() ? ":memory:" : "./chain-duel.db");
  if (isProduction() && !env.CHAIN_DUEL_DB_PATH) {
    console.warn(
      "[chain-duel] No DATABASE_URL configured. Falling back to in-memory SQLite: accounts and duels will not persist between serverless invocations. Set DATABASE_URL to a Postgres connection string for durable state.",
    );
  }
  const driver = await SqliteDriver.open(path, MIGRATIONS);
  return { driver, mode: path === ":memory:" ? "sqlite-memory" : "sqlite-file" };
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
