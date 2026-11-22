import "server-only";
import { isAddress, type Address } from "viem";
import { ARC_NETWORKS, type ArcNetworkId } from "../networks/arc";

export function arcConfig() {
  const selected = process.env.ARC_NETWORK ?? "mainnet";
  if (selected !== "mainnet" && selected !== "testnet")
    throw new Error("ARC_NETWORK must be mainnet or testnet.");
  const networkId: ArcNetworkId = selected === "mainnet" ? "arc-mainnet" : "arc-testnet";
  const network = ARC_NETWORKS[networkId];
  const address = process.env.ARC_DUEL_CONTRACT_ADDRESS;
  const contractAddress: Address | null = address && isAddress(address) ? (address as Address) : null;
  const circleConfigured = Boolean(process.env.CIRCLE_API_KEY && process.env.NEXT_PUBLIC_CIRCLE_APP_ID);
  const keyEnvironmentMatches =
    !process.env.CIRCLE_API_KEY ||
    (selected === "mainnet"
      ? !process.env.CIRCLE_API_KEY.startsWith("TEST_API_KEY:")
      : !process.env.CIRCLE_API_KEY.startsWith("LIVE_API_KEY:"));
  const walletEnabled =
    process.env.ARC_WALLETS_ENABLED === "true" && circleConfigured && keyEnvironmentMatches;
  const gamingEnabled =
    walletEnabled &&
    Boolean(contractAddress) &&
    process.env.ARC_GAMING_ENABLED === "true" &&
    process.env.ARC_CONTRACT_REVIEWED === "true" &&
    Boolean(process.env.ARC_SETTLEMENT_KEY_FILE || process.env.ARC_SETTLEMENT_PRIVATE_KEY);
  return {
    ...network,
    networkId,
    contractAddress,
    circleConfigured,
    walletEnabled,
    gamingEnabled,
    rpcUrl: process.env.ARC_RPC_URL ?? network.rpc,
    appId: process.env.NEXT_PUBLIC_CIRCLE_APP_ID ?? null,
  };
}

export function publicArcConfig() {
  const {
    name,
    id,
    networkId,
    circle,
    explorer,
    testnet,
    contractAddress,
    walletEnabled,
    gamingEnabled,
    appId,
  } = arcConfig();
  return {
    name,
    chainId: id,
    networkId,
    circleBlockchain: circle,
    explorer,
    testnet,
    contractAddress,
    walletEnabled,
    gamingEnabled,
    appId,
  };
}
