import { readFileSync, writeFileSync, statSync, mkdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  erc20Abi,
  isAddress,
  getAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcBuildManifest } from "./arc-build-manifest.mjs";
import { fileURLToPath } from "node:url";

const network = process.env.ARC_NETWORK ?? "mainnet";
if (!["mainnet", "testnet"].includes(network)) throw new Error("ARC_NETWORK must be mainnet or testnet.");
const chainId = network === "mainnet" ? 5042 : 5042002;
const rpcUrl = network === "mainnet" ? "https://rpc.mainnet.arc.io" : "https://rpc.testnet.arc.io";
const explorer = network === "mainnet" ? "https://explorer.arc.io" : "https://explorer.testnet.arc.io";
const chain = defineChain({
  id: chainId,
  name: `Arc ${network}`,
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const usdc = "0x3600000000000000000000000000000000000000";
const client = createPublicClient({
  chain,
  transport: http(rpcUrl, { timeout: 20_000 }),
});
if ((await client.getChainId()) !== chainId) throw new Error("Arc RPC chain ID mismatch.");
if (
  (await client.readContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "decimals",
  })) !== 6
)
  throw new Error("USDC decimals mismatch.");
const { artifact, manifest } = arcBuildManifest();
const sourceHash = manifest.sourceSha256;
function address(name) {
  const value = process.env[name];
  if (!value || !isAddress(value) || /^0x0{40}$/i.test(value))
    throw new Error(`${name} must be configured with a verified recipient address.`);
  return getAddress(value);
}
function amount(name) {
  const value = process.env[name];
  if (!value || !/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value))
    throw new Error(`${name} must be configured as an exact USDC amount.`);
  const [w, f = ""] = value.split(".");
  return BigInt(w) * 1_000_000n + BigInt(f.padEnd(6, "0"));
}
const args = [
  usdc,
  address("ARC_OWNER_ADDRESS"),
  address("ARC_SETTLEMENT_AUTHORITY"),
  address("ARC_PROTOCOL_FEE_RECIPIENT"),
  address("ARC_ECOSYSTEM_FEE_RECIPIENT"),
  address("ARC_BOT_TREASURY"),
  amount("ARC_MIN_STAKE_USDC"),
  amount("ARC_MAX_STAKE_USDC"),
];
if (args[6] <= 0n || args[7] < args[6] || args[7] > (1n << 128n) - 1n) throw new Error("Invalid Arc stake limits.");
const report = {
  ...manifest,
  network: `arc-${network}`,
  chainId,
  token: usdc,
  tokenDecimals: 6,
  compiler: "0.8.30",
  sourceSha256: sourceHash,
  constructorArguments: args.map((x) => (typeof x === "bigint" ? x.toString() : x)),
  constructorArgumentsSha256: createHash("sha256")
    .update(JSON.stringify(args.map((x) => (typeof x === "bigint" ? x.toString() : x))))
    .digest("hex"),
  fees: { winnerBps: 9000, protocolBps: 500, ecosystemBps: 500 },
  preparedAt: new Date().toISOString(),
};
const folder = new URL("../docs/arc-deployments/", import.meta.url);
mkdirSync(folder, { recursive: true });
writeFileSync(new URL(`prepared-${network}.json`, folder), JSON.stringify(report, null, 2) + "\n");
if (!process.argv.includes("--broadcast")) {
  console.log(`Prepared verified ${network} parameters. No transaction broadcast.`);
  process.exit(0);
}
if (network === "mainnet") {
  if (!process.env.ARC_REVIEW_REPORT)
    throw new Error("ARC_REVIEW_REPORT is required before financial-contract Mainnet deployment.");
  const audit = JSON.parse(readFileSync(process.env.ARC_REVIEW_REPORT, "utf8"));
  if (
    audit.sourceSha256 !== sourceHash ||
    audit.creationBytecodeSha256 !== manifest.creationBytecodeSha256 ||
    audit.sourcesSha256 !== manifest.sourcesSha256 ||
    audit.constructorArgumentsSha256 !== report.constructorArgumentsSha256 ||
    audit.approved !== true ||
    typeof audit.auditReference !== "string" ||
    !audit.auditReference.trim()
  )
    throw new Error(
      "The required financial-contract review does not approve the current bytecode, sources and constructor parameters.",
    );
}
const file = process.env.ARC_DEPLOYER_KEY_FILE;
if (!file || (statSync(file).mode & 0o077) !== 0)
  throw new Error("ARC_DEPLOYER_KEY_FILE must be a private signer file outside the repository.");
if (realpathSync(file).startsWith(realpathSync(fileURLToPath(new URL("../", import.meta.url))) + "/"))
  throw new Error("The deployment signer must be outside the repository.");
const secret = readFileSync(file, "utf8").trim();
if (!/^0x[0-9a-fA-F]{64}$/.test(secret)) throw new Error("Invalid deployment signer configuration.");
const account = privateKeyToAccount(secret);
const balance = await client.getBalance({ address: account.address });
if (balance === 0n) throw new Error("The authorized deployment signer has no Arc USDC for gas.");
const wallet = createWalletClient({
  account,
  chain,
  transport: http(rpcUrl, { retryCount: 0, timeout: 20_000 }),
});
const hash = await wallet.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode.object,
  args,
  maxFeePerGas: 40_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
});
const pending = {
  ...report,
  deployer: account.address,
  deploymentTransactionHash: hash,
  status: "submitted",
};
writeFileSync(new URL(`deployment-${network}.json`, folder), JSON.stringify(pending, null, 2) + "\n");
const receipt = await client.waitForTransactionReceipt({
  hash,
  timeout: 120_000,
});
if (receipt.status !== "success" || !receipt.contractAddress)
  throw new Error("Deployment did not succeed. Transaction reference is saved.");
const deployed = receipt.contractAddress;
if (!(await client.getCode({ address: deployed }))) throw new Error("Deployed escrow bytecode missing.");
for (const [method, expected] of [
  ["usdc", args[0]],
  ["owner", args[1]],
  ["settlementAuthority", args[2]],
  ["protocolRecipient", args[3]],
  ["ecosystemRecipient", args[4]],
  ["botRecipient", args[5]],
  ["minStake", args[6]],
  ["maxStake", args[7]],
]) {
  const actual = await client.readContract({
    address: deployed,
    abi: artifact.abi,
    functionName: method,
  });
  if (
    typeof expected === "string"
      ? String(actual).toLowerCase() !== expected.toLowerCase()
      : actual !== expected
  )
    throw new Error(`Deployed ${method} differs from approved parameters.`);
}
const final = {
  ...pending,
  status: "confirmed",
  contractAddress: deployed,
  deploymentBlock: receipt.blockNumber.toString(),
  confirmedAt: new Date().toISOString(),
  explorerUrl: `${explorer}/address/${deployed}`,
  verificationStatus: "pending explorer source verification",
};
writeFileSync(new URL(`deployment-${network}.json`, folder), JSON.stringify(final, null, 2) + "\n");
console.log(`Arc escrow confirmed: ${deployed}. Transaction: ${hash}. Source verification remains required.`);
