/**
 * Builds and deploys the Chain Duel escrow contract to Stellar Testnet.
 *
 * Usage:
 *   CHAIN_DUEL_ADMIN_SECRET=S... node scripts/deploy-contract.mjs
 *
 * The deploying account becomes the contract admin, the settlement authority
 * and the sole treasury withdrawal destination. Its secret key is read from the
 * environment, never written to source control.
 */
import { existsSync } from "node:fs";
import { Keypair } from "@stellar/stellar-sdk";
import { ECONOMY, NATIVE_XLM_SAC_TESTNET, WASM_PATH, loadEnvFile, stellar, upsertEnvFile, friendbot } from "./lib.mjs";

const env = { ...loadEnvFile(), ...process.env };
const secret = env.CHAIN_DUEL_ADMIN_SECRET;
if (!secret) {
  console.error("CHAIN_DUEL_ADMIN_SECRET is required (a Stellar secret key, S...).");
  process.exit(1);
}

const keypair = Keypair.fromSecret(secret);
const admin = keypair.publicKey();
const token = env.CHAIN_DUEL_TOKEN_ID || NATIVE_XLM_SAC_TESTNET;
const network = env.STELLAR_NETWORK || "testnet";

console.log(`Chain Duel contract deployment`);
console.log(`  network : ${network}`);
console.log(`  admin   : ${admin}`);
console.log(`  treasury: ${admin}`);
console.log(`  token   : ${token}`);

await friendbot(admin).catch((error) => console.warn(`Friendbot: ${error.message}`));

console.log("\nBuilding the contract WASM (spec shaking via stellar-cli)…");
stellar(["contract", "build", "--manifest-path", "contracts/chain_duel/Cargo.toml"]);

if (!existsSync(WASM_PATH)) {
  console.error(`Expected WASM at ${WASM_PATH}`);
  process.exit(1);
}

console.log("\nDeploying…");
const output = stellar(
  [
    "contract",
    "deploy",
    "--wasm",
    WASM_PATH,
    "--source-account",
    secret,
    "--network",
    network,
    "--",
    "--admin",
    admin,
    "--treasury",
    admin,
    "--token",
    token,
    "--fee_bps",
    String(ECONOMY.feeBps),
    "--max_entry",
    String(ECONOMY.maxEntryStroops),
    "--max_payout",
    String(ECONOMY.maxPayoutStroops),
    "--min_treasury_balance",
    String(ECONOMY.minTreasuryBalanceStroops),
  ],
  { capture: true },
);

const contractId = (output.match(/C[A-Z0-9]{55}/g) ?? []).pop();
if (!contractId) {
  console.error("Could not read the deployed contract id from the CLI output:");
  console.error(output);
  process.exit(1);
}

console.log(`\n✓ Contract deployed: ${contractId}`);
console.log(`  https://stellar.expert/explorer/testnet/contract/${contractId}`);

const write = process.argv.includes("--write-env");
if (write) {
  const path = upsertEnvFile({
    CHAIN_DUEL_CONTRACT_ID: contractId,
    CHAIN_DUEL_TOKEN_ID: token,
    STELLAR_NETWORK: network,
    ADMIN_WALLET_ADDRESS: admin,
    SETTLEMENT_SECRET_KEY: secret,
  });
  console.log(`\nWrote configuration to ${path} (gitignored).`);
}
