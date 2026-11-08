/** Deploy the stake revision without overwriting the original escrow or secrets.
 * node scripts/deploy-stake-contract.mjs --deploy [--env-file /path/to/env]
 * Writes only a public deployment receipt; set its contract ID in the new
 * CHAIN_DUEL_STAKE_CONTRACT_ID variable after verification.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Keypair } from "@stellar/stellar-sdk";
import { ECONOMY, ROOT, WASM_PATH, loadEnvFile, stellarBin } from "./lib.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const env = { ...loadEnvFile(option("--env-file", `${ROOT}/.env.local`)), ...process.env };
// Vercel's env files use quoted dotenv values.
for (const key of Object.keys(env)) if (typeof env[key] === "string" && /^".*"$/.test(env[key])) env[key] = JSON.parse(env[key]);
assert(env.STELLAR_NETWORK === "testnet", "This rollout script is restricted to Stellar Testnet.");
const secret = env.SETTLEMENT_SECRET_KEY ?? env.CHAIN_DUEL_ADMIN_SECRET;
assert(secret, "A configured settlement signing key is required.");
const admin = Keypair.fromSecret(secret).publicKey();
const originalContract = env.CHAIN_DUEL_CONTRACT_ID;
assert(originalContract, "The original contract must remain configured for legacy games.");
const cliEnv = { ...env, STELLAR_ACCOUNT: secret, RUSTUP_TOOLCHAIN: "1.92.0" };
function cli(commandArgs) {
  try {
    return execFileSync(stellarBin(), commandArgs, { cwd: ROOT, env: cliEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    // Neither the key nor signed envelopes belong in operational logs.
    throw new Error(String(error.stderr ?? "Stellar CLI failed.").replaceAll(secret, "[redacted]").slice(0, 2500));
  }
}
const config = JSON.parse(cli(["contract", "invoke", "--id", originalContract, "--network", "testnet", "--send", "no", "--", "get_config"]));
assert.equal(config.admin, admin, "The signer must be the existing contract admin.");
console.log(JSON.stringify({ originalContract, admin, treasury: config.treasury, token: config.token, minEntryXlm: 25, maxEntryXlm: 10000, maxPoolXlm: 20000 }));
if (!args.includes("--deploy")) {
  console.log("Read-only preflight passed. Use --deploy to build and deploy the tested revision.");
  process.exit(0);
}
console.log("Building the stake contract…");
cli(["contract", "build", "--manifest-path", "contracts/chain_duel/Cargo.toml"]);
const wasmSha256 = createHash("sha256").update(readFileSync(WASM_PATH)).digest("hex");
const output = cli(["contract", "deploy", "--wasm", WASM_PATH, "--network", "testnet", "--", "--admin", admin, "--treasury", config.treasury, "--token", config.token, "--fee_bps", String(config.fee_bps), "--max_entry", String(ECONOMY.maxEntryStroops), "--max_payout", String(ECONOMY.maxPayoutStroops), "--min_treasury_balance", String(config.min_treasury_balance)]);
const contractId = output.match(/C[A-Z2-7]{55}/g)?.at(-1);
assert(contractId, "No contract ID returned by deployment.");
const deployedConfig = JSON.parse(cli(["contract", "invoke", "--id", contractId, "--network", "testnet", "--send", "no", "--", "get_config"]));
assert.equal(BigInt(deployedConfig.max_entry), BigInt(ECONOMY.maxEntryStroops));
assert.equal(BigInt(deployedConfig.max_payout), BigInt(ECONOMY.maxPayoutStroops));
const receipt = { network: "testnet", originalContract, contractId, wasmSha256, deployedAt: new Date().toISOString(), config: deployedConfig };
const receiptPath = option("--receipt", "/private/tmp/chain-duel-stake-deployment.json");
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt));
console.log(`Verified contract deployment. Receipt: ${receiptPath}`);
