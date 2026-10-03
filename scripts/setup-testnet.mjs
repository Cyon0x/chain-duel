/**
 * One-command Testnet bootstrap: create (or reuse) the admin/settlement key,
 * fund it with Friendbot, deploy the escrow contract, and write .env.local.
 *
 * Usage:
 *   node scripts/setup-testnet.mjs              # generate a key if needed
 *   CHAIN_DUEL_ADMIN_SECRET=S... node scripts/setup-testnet.mjs
 */
import { randomBytes } from "node:crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { friendbot, loadEnvFile, upsertEnvFile } from "./lib.mjs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { ROOT } from "./lib.mjs";

const env = { ...loadEnvFile(), ...process.env };
let secret = env.CHAIN_DUEL_ADMIN_SECRET;

if (!secret) {
  // A Stellar ed25519 keypair encoded as a seed: 32 random bytes + CRC16.
  const seed = randomBytes(32);
  secret = StrKey.encodeEd25519SecretSeed(seed);
  console.log("No CHAIN_DUEL_ADMIN_SECRET found — generated a fresh Testnet admin key.");
}

const admin = Keypair.fromSecret(secret).publicKey();
const sessionSecret = env.SESSION_SECRET ?? randomBytes(32).toString("base64url");
const walletKey = env.WALLET_ENCRYPTION_KEY ?? randomBytes(32).toString("base64url");

console.log(`\nFunding ${admin} via Friendbot…`);
await friendbot(admin);
console.log("✓ Funded");

console.log("\nDeploying the escrow contract…");
const output = execFileSync(
  process.execPath,
  [resolve(ROOT, "scripts/deploy-contract.mjs")],
  {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      CHAIN_DUEL_ADMIN_SECRET: secret,
      CHAIN_DUEL_TOKEN_ID: env.CHAIN_DUEL_TOKEN_ID ?? "",
      STELLAR_NETWORK: "testnet",
    },
  },
);
console.log(output);

const contractId = (output.match(/C[A-Z0-9]{55}/g) ?? []).pop();
if (!contractId) {
  console.error("Deployment did not return a contract id.");
  process.exit(1);
}

const path = upsertEnvFile({
  STELLAR_NETWORK: "testnet",
  CHAIN_DUEL_CONTRACT_ID: contractId,
  CHAIN_DUEL_TOKEN_ID: env.CHAIN_DUEL_TOKEN_ID || "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  ADMIN_WALLET_ADDRESS: admin,
  SETTLEMENT_SECRET_KEY: secret,
  SESSION_SECRET: sessionSecret,
  WALLET_ENCRYPTION_KEY: walletKey,
  DEMO_MODE_ENABLED: "true",
  APP_URL: env.APP_URL ?? "http://localhost:4310",
});

console.log(`\n✓ Testnet ready`);
console.log(`  contract: ${contractId}`);
console.log(`  admin   : ${admin}`);
console.log(`  config  : ${path}`);
console.log(`\nFund the bot treasury liquidity next:`);
console.log(`  npm run treasury:fund -- 500`);
