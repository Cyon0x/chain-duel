/** Read-only Stellar migration inventory, signer verification and fee simulation. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Address, Asset, BASE_FEE, Contract, Keypair, Networks, Operation, TransactionBuilder, rpc, scValToNative } from "@stellar/stellar-sdk";
import { ROOT, WASM_PATH, loadEnvFile } from "./lib.mjs";

const ADMIN = "GCQKVXWIQHVGUOUHZR2O6YBWBNNPKIYH5AWQHXHF3EYRHM73WIWVSK7K";
const OWNER_PLAYER = "GBGDTBOXVZ4GIDDRISY5FGXYY7XCWCCK3FRHJHSVFEZMWA3ZZ2HUALTK";
const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const MAINNET_RPC = "https://mainnet.sorobanrpc.com";
const MAINNET_HORIZON = "https://horizon.stellar.org";
const TESTNET_RPC = "https://soroban-testnet.stellar.org";
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const env = loadEnvFile(option("--env-file", `${ROOT}/.env.local`));
for (const key of Object.keys(env)) if (/^".*"$/.test(env[key])) env[key] = JSON.parse(env[key]);
const stringify = value => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
let stage = "signer";

async function getJson(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
  if (response.status === 404) return null;
  assert(response.ok, `Infrastructure request failed with HTTP ${response.status}.`);
  return response.json();
}
async function rawRpc(url, method, params) {
  const response = await getJson(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "chain-duel-preflight", method, ...(params ? { params } : {}) }) });
  assert(response && !response.error, "RPC request failed.");
  return response.result;
}
async function readContract(server, passphrase, account, contractId, method) {
  const transaction = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(new Contract(contractId).call(method)).setTimeout(180).build();
  const simulation = await server.simulateTransaction(transaction);
  if (rpc.Api.isSimulationError(simulation)) return { verified: false, error: simulation.error };
  if (rpc.Api.isSimulationRestore(simulation)) return { verified: false, restorationRequired: true };
  return { verified: true, value: scValToNative(simulation.result.retval) };
}
function balanceSummary(account, baseReserve) {
  if (!account) return { exists: false };
  const native = account.balances.find(b => b.asset_type === "native");
  const usdc = account.balances.find(b => b.asset_code === "USDC" && b.asset_issuer === ISSUER);
  const nativeUnits = decimalUnits(native?.balance ?? "0");
  const liabilities = decimalUnits(native?.selling_liabilities ?? "0");
  const reserveUnits = BigInt(2 + account.subentry_count + (account.num_sponsoring ?? 0) - (account.num_sponsored ?? 0)) * baseReserve;
  return {
    exists: true, address: account.account_id, sequence: account.sequence,
    xlmBalance: native?.balance ?? "0", reserveXlm: unitDecimal(reserveUnits),
    nativeSellingLiabilities: native?.selling_liabilities ?? "0",
    availableBeforeFeesXlm: unitDecimal(nativeUnits - reserveUnits - liabilities),
    subentries: account.subentry_count, sponsoring: account.num_sponsoring ?? 0,
    sponsored: account.num_sponsored ?? 0, thresholds: account.thresholds,
    signers: account.signers, usdcTrustline: Boolean(usdc),
    usdcBalance: usdc?.balance ?? "0.0000000", usdcAuthorized: usdc?.is_authorized ?? null,
    usdcSellingLiabilities: usdc?.selling_liabilities ?? "0.0000000",
  };
}
function decimalUnits(value) {
  assert(/^\d+(?:\.\d{1,7})?$/.test(value), "Invalid seven-decimal balance.");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 10000000n + BigInt(fraction.padEnd(7, "0"));
}
function unitDecimal(value) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / 10000000n}.${(absolute % 10000000n).toString().padStart(7, "0")}`;
}

try {
  assert.equal(env.ADMIN_WALLET_ADDRESS, ADMIN, "Configured deployment address does not match the designated wallet.");
  assert(env.SETTLEMENT_SECRET_KEY && env.SETTLEMENT_SECRET_KEY !== "[SENSITIVE]", "The existing secure signing configuration is unavailable.");
  assert.equal(Keypair.fromSecret(env.SETTLEMENT_SECRET_KEY).publicKey(), ADMIN, "The existing signing key belongs to a different wallet.");
  stage = "mainnet infrastructure";
  const [network, latest, ledgerPage, adminAccount, ownerAccount, feeStats] = await Promise.all([
    rawRpc(MAINNET_RPC, "getNetwork"), rawRpc(MAINNET_RPC, "getLatestLedger"),
    getJson(`${MAINNET_HORIZON}/ledgers?order=desc&limit=1`),
    getJson(`${MAINNET_HORIZON}/accounts/${ADMIN}`),
    getJson(`${MAINNET_HORIZON}/accounts/${OWNER_PLAYER}`),
    rawRpc(MAINNET_RPC, "getFeeStats"),
  ]);
  assert.equal(network.passphrase, Networks.PUBLIC);
  assert(adminAccount, "The designated wallet is not funded on Stellar Mainnet.");
  assert(adminAccount.signers.length === 1 && adminAccount.signers[0].key === ADMIN && adminAccount.signers[0].weight > 0, "The designated account has unexpected signers.");
  const baseReserve = BigInt(ledgerPage._embedded.records[0].base_reserve_in_stroops);
  const mainnet = new rpc.Server(MAINNET_RPC);
  const mainnetSource = await mainnet.getAccount(ADMIN);
  assert.equal(new Asset("USDC", ISSUER).contractId(Networks.PUBLIC), USDC);
  stage = "official Mainnet USDC";
  const [decimals, symbol, name, issuerAdmin] = await Promise.all(
    ["decimals", "symbol", "name", "admin"].map(method => readContract(mainnet, Networks.PUBLIC, mainnetSource, USDC, method)),
  );
  assert(decimals.verified && decimals.value === 7, "Official Stellar USDC precision could not be verified.");
  assert(symbol.verified && symbol.value === "USDC", "Official Stellar USDC symbol could not be verified.");
  assert(name.verified && name.value === `USDC:${ISSUER}`, "Official Stellar USDC asset identity could not be verified.");
  // The issuer has delegated SAC administration to a contract. Asset identity
  // comes from Circle's documented issuer, canonical SAC derivation and name;
  // do not assume the current token administrator equals the issuing account.
  assert(issuerAdmin.verified && typeof issuerAdmin.value === "string", "Official USDC administration could not be read.");
  new Address(issuerAdmin.value).toScVal();
  stage = "existing Testnet deployments";
  const testnet = new rpc.Server(TESTNET_RPC);
  const testnetSource = await testnet.getAccount(ADMIN);
  const testnetIds = [...new Set([env.CHAIN_DUEL_CONTRACT_ID, env.CHAIN_DUEL_STAKE_CONTRACT_ID].filter(Boolean))];
  const deployments = await Promise.all(testnetIds.map(async contractId => {
    const methods = ["get_config", "get_bot_liquidity", "get_accrued_fees", "get_locked_escrow", "get_contract_balance"];
    const values = await Promise.all(methods.map(method => readContract(testnet, Networks.TESTNET, testnetSource, contractId, method)));
    return { network: "testnet", contractId, ...Object.fromEntries(methods.map((method, i) => [method, values[i]])) };
  }));
  stage = "source inventory";
  const referencePattern = "testnet|Testnet|Test SDF|futurenet|Futurenet|friendbot|CDLZFC3|CBBDWEW|CD3EW4E|GBBD47IF";
  const referenceOutput = execFileSync("rg", ["--json", "-g", "!docs/stellar-mainnet-deployments/**", referencePattern, "src", "scripts", "tests", "docs", "contracts/chain_duel/src", ".env.example", "README.md"], { cwd: ROOT, encoding: "utf8", maxBuffer: 4000000 });
  const references = referenceOutput.trim().split("\n").map(line => JSON.parse(line)).filter(row => row.type === "match").map(row => ({
    file: row.data.path.text, line: row.data.line_number,
    purpose: row.data.path.text.startsWith("tests/") ? "test fixture" : row.data.path.text.startsWith("docs/") ? "documentation/history" : row.data.path.text.includes("/arc/") || row.data.path.text.includes("/bridge/") ? "independent Arc/CCTP environment" : row.data.path.text.startsWith("scripts/") ? "operational script" : "Stellar application/configuration",
    text: row.data.lines.text.trim(),
  }));
  const wasm = existsSync(WASM_PATH) ? readFileSync(WASM_PATH) : null;
  const report = {
    schemaVersion: 1, checkedAt: new Date().toISOString(), readOnly: true,
    baselineCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
    designatedWallet: ADMIN, secureSignerMatches: true,
    mainnet: { rpc: MAINNET_RPC, horizon: MAINNET_HORIZON, ...network, latestLedger: latest.sequence, baseReserveXlm: unitDecimal(baseReserve),
      deploymentWallet: balanceSummary(adminAccount, baseReserve), controlledPlayerWallet: balanceSummary(ownerAccount, baseReserve),
      officialUsdc: { issuer: ISSUER, contractId: USDC, documentation: "https://developers.circle.com/stablecoins/usdc-contract-addresses", decimals, symbol, name, issuerAdmin }, feeStats },
    existingTestnetDeployments: deployments,
    existingArtifact: wasm ? { path: WASM_PATH.replace(`${ROOT}/`, ""), bytes: wasm.length, sha256: createHash("sha256").update(wasm).digest("hex") } : null,
    testnetReferences: references,
  };
  if (args.includes("--wasm")) {
    stage = "exact WASM upload fee simulation";
    const path = resolve(option("--wasm"));
    const bytes = readFileSync(path);
    assert(bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])), "Invalid WASM artifact.");
    const transaction = new TransactionBuilder(await mainnet.getAccount(ADMIN), { fee: BASE_FEE, networkPassphrase: Networks.PUBLIC })
      .addOperation(Operation.uploadContractWasm({ wasm: bytes })).setTimeout(180).build();
    const simulation = await mainnet.simulateTransaction(transaction);
    assert(!rpc.Api.isSimulationError(simulation) && !rpc.Api.isSimulationRestore(simulation), "Mainnet upload simulation failed.");
    const assembled = rpc.assembleTransaction(transaction, simulation).build();
    report.uploadQuote = { path: path.replace(`${ROOT}/`, ""), wasmBytes: bytes.length, wasmSha256: createHash("sha256").update(bytes).digest("hex"),
      inclusionFeeUnits: BASE_FEE, resourceFeeUnits: simulation.minResourceFee, totalFeeUnits: assembled.fee, totalFeeXlm: unitDecimal(BigInt(assembled.fee)),
      simulatedAtLedger: simulation.latestLedger, submitted: false };
  }
  const output = resolve(option("--output", `${ROOT}/docs/stellar-mainnet-deployments/preflight.json`));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${stringify(report)}\n`);
  console.log(stringify({ report: output.replace(`${ROOT}/`, ""), readOnly: true, designatedWallet: ADMIN, signerVerified: true,
    xlmBalance: report.mainnet.deploymentWallet.xlmBalance, reserveXlm: report.mainnet.deploymentWallet.reserveXlm,
    availableBeforeFeesXlm: report.mainnet.deploymentWallet.availableBeforeFeesXlm, usdc: { issuer: ISSUER, contractId: USDC, decimals: decimals.value, tokenAdministrator: issuerAdmin.value },
    testnetDeploymentsChecked: deployments.length, referenceCount: references.length, uploadQuote: report.uploadQuote ?? null }));
} catch (error) {
  let diagnostic = String(error?.message ?? "Preflight failed.");
  for (const [key, value] of Object.entries(env)) if (/SECRET|KEY|TOKEN|DATABASE/.test(key) && value?.length > 12) diagnostic = diagnostic.replaceAll(value, "[REDACTED]");
  diagnostic = diagnostic.replace(/S[A-Z2-7]{55}/g, "[REDACTED]");
  console.error(stringify({ stage, error: "Preflight did not pass; no transaction was signed or submitted.", code: error?.code ?? error?.cause?.code ?? error?.name ?? null, diagnostic }));
  process.exitCode = 1;
}
