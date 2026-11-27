/** Public Stellar constants and financial context. Contains no environment secrets. */
export type StellarNetworkId = "testnet" | "futurenet" | "mainnet" | "local";
export type StellarAssetSymbol = "XLM" | "USDC";

export const STELLAR_DEPLOYMENT_ADMIN = "GCQKVXWIQHVGUOUHZR2O6YBWBNNPKIYH5AWQHXHF3EYRHM73WIWVSK7K";
export const STELLAR_MAINNET_USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
export const STELLAR_MAINNET_USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
export const STELLAR_TESTNET_XLM = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
export const STELLAR_TESTNET_USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
export const STELLAR_TESTNET_USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
export const STELLAR_PUBLIC_PASSPHRASE = "Public Global Stellar Network ; September 2015";
export const STELLAR_TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

export interface StellarPublicConfig {
  id: StellarNetworkId;
  networkId: `stellar-${StellarNetworkId}`;
  label: string;
  networkPassphrase: string;
  rpcUrl: string;
  explorerUrl: string;
  isTestnet: boolean;
  contractId: string | null;
  asset: { symbol: StellarAssetSymbol; decimals: 7; issuer: string | null; contractId: string };
  feeSplit: { winnerBps: number; protocolBps: number; ecosystemBps: number };
  gamingEnabled: boolean;
  mainnetVerified: boolean;
  playerSigning?: "legacy" | "client";
  verification?: { version: 1; rulesHash: string; wasmHash: string; admin: string };
}

export interface StellarFinancialContext {
  verification_version?: number;
  stellar_network?: StellarNetworkId;
  currency?: StellarAssetSymbol;
  token_contract_id?: string | null;
  protocol_fee_bps?: number;
  ecosystem_fee_bps?: number;
}

/** Missing context belongs to historical Testnet XLM, never to new Mainnet USDC. */
export function financialNetwork(record: StellarFinancialContext): StellarNetworkId {
  return record.stellar_network ?? "testnet";
}

export function financialSymbol(record: StellarFinancialContext): StellarAssetSymbol {
  return record.currency ?? (financialNetwork(record) === "mainnet" ? "USDC" : "XLM");
}

export function stellarExplorerBase(network: StellarNetworkId): string {
  return `https://stellar.expert/explorer/${network === "mainnet" ? "public" : "testnet"}`;
}

export function stellarNetworkLabel(network: StellarNetworkId): string {
  return network === "mainnet" ? "Stellar Mainnet" : network === "futurenet" ? "Stellar Futurenet" : network === "local" ? "Local Sandbox" : "Stellar Testnet";
}

export function stellarPoolSplit(pool: number, protocolBps: number, ecosystemBps: number) {
  if (!Number.isSafeInteger(pool) || pool < 0 || !Number.isInteger(protocolBps) || !Number.isInteger(ecosystemBps) || protocolBps < 0 || ecosystemBps < 0 || protocolBps + ecosystemBps > 3000) {
    throw new Error("Invalid Stellar prize accounting.");
  }
  const protocol = Number(BigInt(pool) * BigInt(protocolBps) / 10000n);
  const ecosystem = Number(BigInt(pool) * BigInt(ecosystemBps) / 10000n);
  return { protocol, ecosystem, fee: protocol + ecosystem, payout: pool - protocol - ecosystem };
}
