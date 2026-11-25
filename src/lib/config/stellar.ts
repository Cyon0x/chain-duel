import "server-only";
import { rawEnv } from "./env";
import { StrKey } from "@stellar/stellar-sdk";
import { STELLAR_DEPLOYMENT_ADMIN, STELLAR_MAINNET_USDC, STELLAR_MAINNET_USDC_ISSUER, STELLAR_PUBLIC_PASSPHRASE, STELLAR_TESTNET_USDC, STELLAR_TESTNET_USDC_ISSUER, STELLAR_TESTNET_XLM, type StellarNetworkId, type StellarPublicConfig } from "../stellar/shared";
import { playerControlledSigningEnabled, serverPulseRulesHash, stellarVerificationEnabled, verifiedContractId } from "./stellar-verification";

export type { StellarNetworkId } from "../stellar/shared";

export interface StellarNetworkConfig {
  id: StellarNetworkId;
  label: string;
  rpcUrl: string;
  horizonUrl: string;
  networkPassphrase: string;
  explorerUrl: string;
  friendbotUrl: string | null;
  nativeTokenContractId: string;
  isTestnet: boolean;
}

const NETWORKS: Record<StellarNetworkId, StellarNetworkConfig> = {
  testnet: {
    id: "testnet",
    label: "Stellar Testnet",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerUrl: "https://stellar.expert/explorer/testnet",
    friendbotUrl: "https://friendbot.stellar.org",
    // Native XLM Stellar Asset Contract on Testnet.
    nativeTokenContractId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    isTestnet: true,
  },
  futurenet: {
    id: "futurenet",
    label: "Stellar Futurenet",
    rpcUrl: "https://rpc-futurenet.stellar.org",
    horizonUrl: "https://horizon-futurenet.stellar.org",
    networkPassphrase: "Test SDF Future Network ; October 2022",
    explorerUrl: "https://stellar.expert/explorer/futurenet",
    friendbotUrl: "https://friendbot-futurenet.stellar.org",
    nativeTokenContractId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    isTestnet: true,
  },
  mainnet: {
    id: "mainnet",
    label: "Stellar Mainnet",
    rpcUrl: "https://mainnet.sorobanrpc.com",
    horizonUrl: "https://horizon.stellar.org",
    networkPassphrase: "Public Global Stellar Network ; September 2015",
    explorerUrl: "https://stellar.expert/explorer/public",
    friendbotUrl: null,
    nativeTokenContractId: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
    isTestnet: false,
  },
  local: {
    id: "local",
    label: "Local Sandbox",
    rpcUrl: "http://localhost:8000/soroban/rpc",
    horizonUrl: "http://localhost:8000",
    networkPassphrase: "Standalone Network ; February 2017",
    explorerUrl: "https://stellar.expert/explorer/testnet",
    friendbotUrl: "http://localhost:8000/friendbot",
    nativeTokenContractId: "",
    isTestnet: true,
  },
};

export function stellarNetwork(networkId?: StellarNetworkId): StellarNetworkConfig {
  const env = rawEnv();
  const configured = env.STELLAR_NETWORK ?? "testnet";
  const id = networkId ?? configured;
  const base = NETWORKS[id];
  if (!base) throw new Error("Unknown Stellar network.");
  // Current overrides apply only to the current network. Legacy Testnet games
  // always keep their own endpoints when production switches to Mainnet.
  const current = id === configured;
  if (id === "mainnet" && current) {
    if (env.STELLAR_NETWORK_PASSPHRASE && env.STELLAR_NETWORK_PASSPHRASE !== STELLAR_PUBLIC_PASSPHRASE) throw new Error("Stellar Mainnet passphrase mismatch.");
    if (/testnet|futurenet/i.test(env.STELLAR_RPC_URL ?? "") || /testnet|futurenet/i.test(env.STELLAR_HORIZON_URL ?? "")) throw new Error("Stellar Mainnet cannot use Testnet infrastructure.");
  }
  return {
    ...base,
    rpcUrl: current ? env.STELLAR_RPC_URL ?? base.rpcUrl : base.rpcUrl,
    horizonUrl: current ? env.STELLAR_HORIZON_URL ?? base.horizonUrl : base.horizonUrl,
    networkPassphrase: current ? env.STELLAR_NETWORK_PASSPHRASE ?? base.networkPassphrase : base.networkPassphrase,
  };
}

export function contractId(networkId?: StellarNetworkId): string | null {
  if (stellarVerificationEnabled(networkId)) return verifiedContractId(networkId);
  if (stellarNetwork(networkId).id === "mainnet") {
    const id = checkedContractId(rawEnv().CHAIN_DUEL_MAINNET_CONTRACT_ID);
    if (id && [rawEnv().CHAIN_DUEL_CONTRACT_ID, rawEnv().CHAIN_DUEL_STAKE_CONTRACT_ID, "CBBDWEWBBQVQXNYUJ4FA6C2CXXUVDAJSNUOVPZNKTQWK5P2EON7KEGMZ", "CD3EW4ENWDYGOGQGBJ7G2NU2YV4MLGSQW7CEIBZOYR2NQ4NJ7ZIOZ6FA", STELLAR_TESTNET_XLM, STELLAR_MAINNET_USDC].includes(id)) throw new Error("Mainnet requires its independently deployed Chain Duel escrow.");
    return id;
  }
  return checkedContractId(rawEnv().CHAIN_DUEL_STAKE_CONTRACT_ID?.trim() || rawEnv().CHAIN_DUEL_CONTRACT_ID);
}

/** Original escrow remains available for games created before the stake rollout. */
export function legacyContractId(): string | null {
  return checkedContractId(rawEnv().CHAIN_DUEL_CONTRACT_ID);
}

function checkedContractId(value: string | undefined): string | null {
  const id = value?.trim();
  if (!id) return null;
  if (!StrKey.isValidContract(id)) {
    throw new Error("The configured Soroban contract id is invalid.");
  }
  return id;
}

export function tokenContractId(networkId?: StellarNetworkId): string {
  const network = stellarNetwork(networkId);
  if (network.id === "mainnet") {
    const configured = rawEnv().STELLAR_NETWORK === "mainnet" ? rawEnv().CHAIN_DUEL_TOKEN_ID?.trim() : undefined;
    if (configured && configured !== STELLAR_MAINNET_USDC) throw new Error("Mainnet gaming requires the official Circle USDC contract.");
    return STELLAR_MAINNET_USDC;
  }
  if (network.id === "testnet" && rawEnv().STELLAR_NETWORK === "mainnet") return rawEnv().CHAIN_DUEL_TESTNET_TOKEN_ID?.trim() || STELLAR_TESTNET_XLM;
  const configured = network.id === (rawEnv().STELLAR_NETWORK ?? "testnet") ? rawEnv().CHAIN_DUEL_TOKEN_ID?.trim() : undefined;
  if (configured) return configured;
  return network.nativeTokenContractId;
}

export function explorerTxUrl(hash: string, networkId?: StellarNetworkId): string {
  return `${stellarNetwork(networkId).explorerUrl}/tx/${hash}`;
}

export function explorerAccountUrl(address: string, networkId?: StellarNetworkId): string {
  return `${stellarNetwork(networkId).explorerUrl}/account/${address}`;
}

export function explorerContractUrl(id: string, networkId?: StellarNetworkId): string {
  return `${stellarNetwork(networkId).explorerUrl}/contract/${id}`;
}

export function stellarGamingAllowed(userId?: string): boolean {
  if (stellarNetwork().id !== "mainnet") return true;
  const env = rawEnv();
  if (env.STELLAR_MAINNET_CONTRACT_REVIEWED !== "true") return false;
  if (env.STELLAR_MAINNET_GAMING_ENABLED === "true" && env.STELLAR_MAINNET_E2E_VERIFIED === "true") return true;
  return Boolean(userId && env.STELLAR_MAINNET_VALIDATION_USER_IDS?.split(",").map(id => id.trim()).includes(userId));
}

/** Config exposed to the browser. Never contains secrets. */
export function publicStellarConfig(userId?: string): StellarPublicConfig {
  const net = stellarNetwork();
  const token = tokenContractId();
  const verified = stellarVerificationEnabled();
  const usdc = net.id === "mainnet" || token === STELLAR_TESTNET_USDC;
  return {
    id: net.id,
    networkId: `stellar-${net.id}`,
    label: net.label,
    networkPassphrase: net.networkPassphrase,
    rpcUrl: net.rpcUrl,
    explorerUrl: net.explorerUrl,
    isTestnet: net.isTestnet,
    contractId: contractId(),
    asset: { symbol: usdc ? "USDC" : "XLM", decimals: 7, issuer: usdc ? net.id === "mainnet" ? STELLAR_MAINNET_USDC_ISSUER : STELLAR_TESTNET_USDC_ISSUER : null, contractId: token },
    feeSplit: { winnerBps: 9000, protocolBps: net.id === "mainnet" || verified ? 500 : 1000, ecosystemBps: net.id === "mainnet" || verified ? 500 : 0 },
    gamingEnabled: stellarGamingAllowed(userId),
    mainnetVerified: net.id === "mainnet" && rawEnv().STELLAR_MAINNET_E2E_VERIFIED === "true",
    ...(playerControlledSigningEnabled() ? { playerSigning: "client" as const } : {}),
    ...(verified ? { verification: { version: 1 as const, rulesHash: serverPulseRulesHash(), wasmHash: rawEnv().STELLAR_VERIFIED_WASM_HASH!, admin: STELLAR_DEPLOYMENT_ADMIN } } : {}),
  };
}
