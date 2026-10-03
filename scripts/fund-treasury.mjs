/**
 * Moves XLM from the admin account into the contract's bot pool so computer
 * matches have real Testnet liquidity to pay out from.
 *
 * Usage: npm run treasury:fund -- 500     (500 XLM)
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { ROOT, loadEnvFile, stellarBin } from "./lib.mjs";

const env = { ...loadEnvFile(), ...process.env };
const secret = env.CHAIN_DUEL_ADMIN_SECRET ?? env.SETTLEMENT_SECRET_KEY;
const contractId = env.CHAIN_DUEL_CONTRACT_ID;
const xlm = Number(process.argv[2] ?? "0");

if (!secret || !contractId) {
  console.error("CHAIN_DUEL_ADMIN_SECRET and CHAIN_DUEL_CONTRACT_ID must be configured.");
  process.exit(1);
}
if (!Number.isFinite(xlm) || xlm <= 0) {
  console.error("Pass the amount in XLM, e.g. `npm run treasury:fund -- 500`.");
  process.exit(1);
}

const stroops = String(Math.round(xlm * 10_000_000));
const output = execFileSync(
  stellarBin(),
  [
    "contract", "invoke",
    "--id", contractId,
    "--source-account", secret,
    "--network", env.STELLAR_NETWORK ?? "testnet",
    "--",
    "fund_bot_pool",
    "--from", (await import("@stellar/stellar-sdk")).Keypair.fromSecret(secret).publicKey(),
    "--amount", stroops,
  ],
  { cwd: ROOT, encoding: "utf8" },
);
console.log(output);
console.log(`\n✓ Funded the bot treasury with ${xlm} XLM`);
