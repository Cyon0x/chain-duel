import { defineChain, type Address } from "viem";

// Official Arc references: docs.arc.io/arc/references/connect-to-arc and contract-addresses.
export const ARC_USDC: Address = "0x3600000000000000000000000000000000000000";
export const USDC_DECIMALS = 6;
export const ARC_MIN_MAX_FEE = 20_000_000_000n;
export type ArcNetworkId = "arc-mainnet" | "arc-testnet";
export const ARC_NETWORKS = {
  "arc-mainnet": {
    id: 5042,
    name: "Arc Mainnet",
    rpc: "https://rpc.mainnet.arc.io",
    explorer: "https://explorer.arc.io",
    circle: "ARC",
    testnet: false,
  },
  "arc-testnet": {
    id: 5042002,
    name: "Arc Testnet",
    rpc: "https://rpc.testnet.arc.io",
    explorer: "https://explorer.testnet.arc.io",
    circle: "ARC-TESTNET",
    testnet: true,
  },
} as const;

export function arcNetwork(id: ArcNetworkId) {
  const config = ARC_NETWORKS[id];
  return defineChain({
    id: config.id,
    name: config.name,
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [config.rpc] } },
    blockExplorers: { default: { name: "Arc Explorer", url: config.explorer } },
    testnet: config.testnet,
  });
}

export function parseUsdc(input: string): bigint {
  if (!/^(0|[1-9]\d{0,12})(\.\d{1,6})?$/.test(input))
    throw new Error("Enter a USDC amount with up to six decimal places.");
  const [whole, fraction = ""] = input.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

export function formatUsdc(units: string | bigint): string {
  const amount = BigInt(units);
  const sign = amount < 0n ? "-" : "";
  const absolute = amount < 0n ? -amount : amount;
  const fraction = (absolute % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${sign}${absolute / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}

export function arcPoolSplit(stake: bigint) {
  const pool = stake * 2n;
  const protocol = (pool * 500n) / 10_000n;
  const ecosystem = (pool * 500n) / 10_000n;
  return { pool, protocol, ecosystem, winner: pool - protocol - ecosystem };
}
