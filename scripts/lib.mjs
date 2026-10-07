/**
 * Shared helpers for Chain Duel operational scripts.
 *
 * These scripts deliberately avoid importing `src/**` so they can run under
 * plain Node: the TypeScript sources use bundler-style extensionless imports
 * and `server-only` guards. Anything they need from the app is either read from
 * environment variables or fetched over HTTP from the running app.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_DIR = resolve(ROOT, "contracts/chain_duel");
export const WASM_PATH = resolve(CONTRACT_DIR, "target/wasmv1-none/release/chain_duel.wasm").replace(
  "wasmv1-none",
  "wasm32v1-none",
);

/** Values mirrored from src/lib/config/game.ts — the contract enforces them too. */
export const ECONOMY = {
  feeBps: 1000,
  maxEntryStroops: 2_500_000_000, // 250 XLM (largest stake preset)
  maxPayoutStroops: 5_000_000_000, // 500 XLM (covers a 250+250 XLM pool payout)
  minTreasuryBalanceStroops: 1_000_000_000, // 100 XLM
};

export const NATIVE_XLM_SAC_TESTNET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
export const FRIENDBOT_URL = "https://friendbot.stellar.org";

export function loadEnvFile(path = resolve(ROOT, ".env.local")) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) out[match[1]] = match[2];
  }
  return out;
}

export function upsertEnvFile(entries, path = resolve(ROOT, ".env.local")) {
  const existing = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  const keys = new Set(Object.keys(entries));
  const kept = existing.filter((line) => {
    const match = /^([A-Z0-9_]+)=/.exec(line.trim());
    return !match || !keys.has(match[1]);
  });
  const block = Object.entries(entries).map(([key, value]) => `${key}=${value}`);
  const next = [...kept.filter((line) => line.trim() !== ""), "", ...block, ""].join("\n");
  writeFileSync(path, next, { mode: 0o600 });
  return path;
}

export function run(command, args, options = {}) {
  process.stdout.write(`\n$ ${command} ${args.join(" ")}\n`);
  return execFileSync(command, args, {
    cwd: options.cwd ?? ROOT,
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
    // The contract pins Rust 1.91 via rust-toolchain.toml; pin it explicitly so
    // the build behaves the same regardless of the invoking directory.
    env: { RUSTUP_TOOLCHAIN: process.env.RUSTUP_TOOLCHAIN ?? "1.92.0", ...process.env, ...(options.env ?? {}) },
  });
}

/**
 * Resolves the stellar CLI: an explicit STELLAR_BIN, then PATH, then the
 * per-user install location used by the project's setup docs.
 */
export function stellarBin() {
  if (process.env.STELLAR_BIN) return process.env.STELLAR_BIN;
  const candidates = [
    resolve(homedir(), ".local/bin/stellar"),
    "/opt/homebrew/bin/stellar",
    "/usr/local/bin/stellar",
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? "stellar";
}

export function stellar(args, options = {}) {
  return run(stellarBin(), args, options);
}

export async function friendbot(address) {
  const response = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(address)}`);
  const body = await response.text();
  if (!response.ok && !/already funded|createAccountAlreadyExist/i.test(body)) {
    throw new Error(`Friendbot failed (${response.status}): ${body.slice(0, 300)}`);
  }
  return body;
}
