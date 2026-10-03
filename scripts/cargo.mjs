#!/usr/bin/env node
/**
 * Thin wrapper around the Rust toolchain for the Soroban contract.
 *
 * The contract pins Rust via `contracts/chain_duel/rust-toolchain.toml`, but
 * rustup resolves the toolchain from the *invoking* directory, not the
 * `--manifest-path`. Running `npm run test:contract` from the repo root would
 * therefore fall back to whatever default toolchain is installed. This wrapper
 * pins the toolchain explicitly so `cargo test` / `cargo build` behave the same
 * no matter where they are invoked from.
 */
import { spawnSync } from "node:child_process";

const toolchain = process.env.RUSTUP_TOOLCHAIN ?? "1.92.0";
const result = spawnSync("cargo", process.argv.slice(2), {
  stdio: "inherit",
  env: { ...process.env, RUSTUP_TOOLCHAIN: toolchain },
});

if (result.error) {
  console.error(`Failed to run cargo: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
