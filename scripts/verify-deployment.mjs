/**
 * Reads the deployed contract back from Stellar Testnet and prints its
 * configuration, stats and treasury state. This is the proof that the
 * deployment is real: nothing here is cached or mocked.
 */
import { execFileSync } from "node:child_process";
import { ROOT, loadEnvFile, stellarBin } from "./lib.mjs";

const env = { ...loadEnvFile(), ...process.env };
const contractId = env.CHAIN_DUEL_CONTRACT_ID;
const secret = env.CHAIN_DUEL_ADMIN_SECRET ?? env.SETTLEMENT_SECRET_KEY;

if (!contractId) {
  console.error("CHAIN_DUEL_CONTRACT_ID is not configured.");
  process.exit(1);
}

function invoke(method, extra = []) {
  const args = [
    "contract", "invoke",
    "--id", contractId,
    "--network", env.STELLAR_NETWORK ?? "testnet",
    ...(secret ? ["--source-account", secret] : []),
    "--",
    method,
    ...extra,
  ];
  return execFileSync(stellarBin(), args, { cwd: ROOT, encoding: "utf8" }).trim();
}

console.log(`Chain Duel contract ${contractId}`);
console.log(`explorer: https://stellar.expert/explorer/testnet/contract/${contractId}\n`);

for (const method of ["get_config", "get_stats", "get_bot_liquidity", "get_accrued_fees", "get_locked_escrow", "get_contract_balance"]) {
  try {
    console.log(`── ${method}`);
    console.log(invoke(method));
    console.log("");
  } catch (error) {
    console.log(`   failed: ${String(error.message).split("\n")[0]}\n`);
  }
}
