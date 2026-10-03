import { rawEnv } from "./env";

export type StellarNetworkId = "testnet" | "futurenet" | "mainnet" | "local";

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
    label: "Stellar Public Network",
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

export function stellarNetwork(): StellarNetworkConfig {
  const env = rawEnv();
  const id = (env.STELLAR_NETWORK ?? "testnet") as StellarNetworkId;
  const base = NETWORKS[id] ?? NETWORKS.testnet;
  return {
    ...base,
    rpcUrl: env.STELLAR_RPC_URL ?? base.rpcUrl,
    horizonUrl: env.STELLAR_HORIZON_URL ?? base.horizonUrl,
    networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE ?? base.networkPassphrase,
  };
}

export function contractId(): string | null {
  const id = rawEnv().CHAIN_DUEL_CONTRACT_ID?.trim();
  if (!id) return null;
  if (!/^C[A-Z0-9]{55}$/.test(id)) {
    throw new Error(`CHAIN_DUEL_CONTRACT_ID is not a valid Soroban contract id: ${id}`);
  }
  return id;
}

export function tokenContractId(): string {
  const configured = rawEnv().CHAIN_DUEL_TOKEN_ID?.trim();
  if (configured) return configured;
  return stellarNetwork().nativeTokenContractId;
}

export function explorerTxUrl(hash: string): string {
  return `${stellarNetwork().explorerUrl}/tx/${hash}`;
}

export function explorerAccountUrl(address: string): string {
  return `${stellarNetwork().explorerUrl}/account/${address}`;
}

export function explorerContractUrl(id: string): string {
  return `${stellarNetwork().explorerUrl}/contract/${id}`;
}

/** Config exposed to the browser. Never contains secrets. */
export function publicStellarConfig() {
  const net = stellarNetwork();
  return {
    id: net.id,
    label: net.label,
    networkPassphrase: net.networkPassphrase,
    rpcUrl: net.rpcUrl,
    explorerUrl: net.explorerUrl,
    isTestnet: net.isTestnet,
    contractId: contractId(),
  };
}
