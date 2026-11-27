/** Isolated, guarded Testnet Preview. Never changes production configuration. */
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes, createHash } from "node:crypto";
import { parseEnv } from "node:util";
import { execFileSync, spawn } from "node:child_process";
import pg from "pg";
import { Keypair } from "@stellar/stellar-sdk";

const ROOT = resolve(import.meta.dirname, "..");
const STATE = resolve(homedir(), ".local/state/chain-duel/stellar-verified-testnet/preview-env.json");
const BRANCH = "feat/stellar-independent-verification";
const PROJECT = "prj_t13Ie3yvWd3qTjpr1dbzwllWZSUo"; const TEAM = "team_eidxVnjpU02SdQlp6KzN01MO";
const local = parseEnv(await readFile(resolve(ROOT, ".env.local"), "utf8"));
const evidence = JSON.parse(await readFile(resolve(ROOT, "docs/stellar-verified-deployments/testnet-evidence.json"), "utf8"));
const action = process.argv[2] ?? "--prepare";
const port = process.env.CHAIN_DUEL_PREVIEW_PORT ?? "4315";
const digest = value => createHash("sha256").update(value).digest("hex");
const reportPath = resolve(ROOT, "docs/stellar-verified-deployments/preview-configuration.json");
const vercel = (path, method, body) => {
  const args = ["api", `${path}${path.includes("?") ? "&" : "?"}teamId=${TEAM}`, "--raw"];
  if (method) args.push("--method", method); if (body) args.push("--input", "-");
  try { return JSON.parse(execFileSync("vercel", args, { cwd: ROOT, encoding: "utf8", input: body ? JSON.stringify(body) : undefined, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 4000000 })); }
  catch (error) {
    let reason = String(error.stderr ?? error.stdout ?? "request failed");
    for (const value of Object.values(local).filter(value => value && value.length > 8)) reason = reason.split(value).join("[REDACTED]");
    reason = reason.replace(/\bS[A-Z2-7]{55}\b/g, "[REDACTED]");
    throw new Error(`The branch Preview configuration request failed: ${reason.slice(-1000)}`);
  }
};
try {
  assert.equal(evidence.network, "testnet"); assert(evidence.deployed && evidence.wasmIndependentlyVerified && evidence.testStatus === "complete", "Complete independent Testnet financial verification before preparing a public Preview.");
  assert.equal(digest(await readFile(resolve(ROOT, "contracts/chain_duel_mainnet/target/wasm32v1-none/release/chain_duel_mainnet.wasm"))), evidence.wasmSha256);
  const admin = Keypair.fromSecret((local.SETTLEMENT_SECRET_KEY ?? local.TREASURY_SECRET_KEY ?? "").trim()); assert.equal(admin.publicKey(), evidence.admin);
  let values;
  try { values = JSON.parse(await readFile(STATE, "utf8")); } catch { values = null; }
  if (action === "--prepare" && !values) {
    const isolated = (await readFile("/private/tmp/chain-duel-preview-database-url", "utf8")).trim();
    const parsed = new URL(isolated); assert.equal(parsed.pathname, "/chain_duel_multichain_preview", "Use only the existing isolated Preview database.");
    const pool = new pg.Pool({ connectionString: isolated, ssl: { rejectUnauthorized: false }, max: 1 });
    const current = (await pool.query("SELECT current_database() AS database")).rows[0]; assert.equal(current.database, "chain_duel_multichain_preview");
    await pool.query("CREATE SCHEMA IF NOT EXISTS chain_duel_verified_preview"); await pool.end();
    parsed.hostname = parsed.hostname.replace("-pooler.", "."); parsed.searchParams.set("options", "-c search_path=chain_duel_verified_preview");
    const verify = new pg.Pool({ connectionString: parsed.toString(), ssl: { rejectUnauthorized: false }, max: 1 });
    assert.equal((await verify.query("SELECT current_schema() AS schema")).rows[0].schema, "chain_duel_verified_preview"); await verify.end();
    values = { DATABASE_URL: parsed.toString(), SESSION_SECRET: randomBytes(48).toString("base64url"), CRON_SECRET: randomBytes(48).toString("base64url"),
      WALLET_ENCRYPTION_KEY: "player-controlled-preview-no-legacy-decryption-access", STELLAR_SIGNER_DATABASE_URL: "",
      STELLAR_NETWORK: "testnet", STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015", STELLAR_RPC_URL: "https://soroban-testnet.stellar.org", STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
      CHAIN_DUEL_TOKEN_ID: evidence.token, CHAIN_DUEL_CONTRACT_ID: "", CHAIN_DUEL_STAKE_CONTRACT_ID: "", CHAIN_DUEL_MAINNET_CONTRACT_ID: "",
      ADMIN_WALLET_ADDRESS: evidence.admin, SETTLEMENT_SECRET_KEY: admin.secret(), TREASURY_SECRET_KEY: "",
      STELLAR_PLAYER_SIGNING_MODE: "client", STELLAR_VERIFICATION_VERSION: "1", CHAIN_DUEL_VERIFIED_CONTRACT_ID: evidence.contractId, STELLAR_VERIFIED_WASM_HASH: evidence.wasmSha256,
      STELLAR_VERIFIED_MAINNET_APPROVED: "false", STELLAR_MAINNET_GAMING_ENABLED: "false", STELLAR_MAINNET_E2E_VERIFIED: "false", STELLAR_MAINNET_CONTRACT_REVIEWED: "false", STELLAR_MAINNET_VALIDATION_USER_IDS: "",
      NEXT_PUBLIC_STELLAR_VERIFIED_CONTRACT_ID: evidence.contractId, NEXT_PUBLIC_STELLAR_VERIFIED_WASM_HASH: evidence.wasmSha256, NEXT_PUBLIC_STELLAR_VERIFIED_NETWORK: "testnet", DEMO_MODE_ENABLED: "true",
    };
    await mkdir(dirname(STATE), { recursive: true, mode: 0o700 }); await writeFile(STATE, JSON.stringify(values), { mode: 0o600 });
  }
  assert(values, "Prepare the isolated Preview configuration first.");
  assert.equal(values.CHAIN_DUEL_VERIFIED_CONTRACT_ID, evidence.contractId); assert.equal(values.STELLAR_VERIFIED_WASM_HASH, evidence.wasmSha256);
  // Branch Preview must not inherit live Arc/bridge operation switches.
  Object.assign(values, { APP_URL: "", ARC_WALLETS_ENABLED: "false", ARC_GAMING_ENABLED: "false", BRIDGE_ENABLED: "false" });
  await writeFile(STATE, JSON.stringify(values), { mode: 0o600 });
  const report = { branch: BRANCH, network: "testnet", schema: "chain_duel_verified_preview", isolatedDatabase: true, contractId: evidence.contractId, wasmSha256: evidence.wasmSha256,
    playerControlledSigning: true, legacyPlayerCiphertextsAvailable: false, legacyDecryptionCredentialAvailable: false, mainnetEnabled: false, productionModified: false,
    admin: evidence.admin, arcFinancialOperationsEnabled: false, bridgeFinancialOperationsEnabled: false, environmentVariableNames: Object.keys(values).sort(), timestamp: new Date().toISOString() };
  if (action === "--vercel-env") {
    assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: ROOT, encoding: "utf8" }).trim(), BRANCH);
    const existing = vercel(`/v9/projects/${PROJECT}/env`).envs ?? [];
    for (const [key, value] of Object.entries(values)) {
      const found = existing.find(item => item.key === key && item.gitBranch === BRANCH && item.target.includes("preview"));
      const payload = { key, value, type: ["DATABASE_URL", "SESSION_SECRET", "CRON_SECRET", "SETTLEMENT_SECRET_KEY"].includes(key) ? "sensitive" : "encrypted", target: ["preview"], gitBranch: BRANCH };
      if (found) {
        const update = { ...payload }; delete update.key;
        vercel(`/v9/projects/${PROJECT}/env/${found.id}`, "PATCH", update);
      }
      else vercel(`/v10/projects/${PROJECT}/env`, "POST", payload);
      process.stdout.write(`Configured branch Preview ${key}.\n`);
    }
    report.branchVercelEnvironmentConfigured = true;
  } else if (["--build", "--start", "--dev"].includes(action)) {
    // Local QA cannot trigger Arc or bridge financial operations. Arc source,
    // contracts and production environment remain unchanged.
    const environment = { ...process.env, ...values, APP_URL: `http://localhost:${port}`, ARC_WALLETS_ENABLED: "false", ARC_GAMING_ENABLED: "false", BRIDGE_ENABLED: "false" };
    const args = action === "--build" ? ["build", "--webpack"] : action === "--dev" ? ["dev", "--webpack", "-p", port] : ["start", "-p", port];
    const child = spawn(process.execPath, [resolve(ROOT, "node_modules/next/dist/bin/next"), ...args], { cwd: ROOT, env: environment, stdio: "inherit" });
    process.exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
  } else assert.equal(action, "--prepare");
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  if (action === "--prepare") process.stdout.write(`Prepared isolated Testnet Preview for ${evidence.contractId}. No production setting was changed.\n`);
} catch (error) {
  const secretValues = Object.values(local).filter(value => value && value.length > 10);
  let message = String(error?.message ?? "Preview preparation failed");
  for (const value of secretValues) message = message.split(value).join("[REDACTED]");
  process.stderr.write(`Preview preparation stopped: ${message.replace(/\bS[A-Z2-7]{55}\b/g, "[REDACTED]")}\n`); process.exitCode = 1;
}
