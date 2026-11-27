/**
 * Client-safe explorer helpers. Every financial record supplies its own network;
 * an unbound historical record retains Testnet.
 */
import { stellarExplorerBase, type StellarNetworkId } from "./stellar/shared";
export const EXPLORER_BASE = stellarExplorerBase("testnet");

export function txExplorerUrl(hash: string | null | undefined, network: StellarNetworkId = "testnet"): string | null {
  if (!hash) return null;
  return `${stellarExplorerBase(network)}/tx/${hash}`;
}

export function accountExplorerUrl(address: string, network: StellarNetworkId = "testnet"): string {
  return `${stellarExplorerBase(network)}/account/${address}`;
}

export function contractExplorerUrl(id: string, network: StellarNetworkId = "testnet"): string {
  return `${stellarExplorerBase(network)}/contract/${id}`;
}

export function truncateAddress(address: string | null | undefined, size = 4): string {
  if (!address) return "—";
  if (address.length <= size * 2 + 3) return address;
  return `${address.slice(0, size + 1)}…${address.slice(-size)}`;
}
