/**
 * Client-safe Stellar explorer helpers. Chain Duel ships on Testnet; the URL
 * can be overridden at build time with NEXT_PUBLIC_STELLAR_EXPLORER_URL.
 */
export const EXPLORER_BASE =
  process.env.NEXT_PUBLIC_STELLAR_EXPLORER_URL ?? "https://stellar.expert/explorer/testnet";

export function txExplorerUrl(hash: string | null | undefined): string | null {
  if (!hash) return null;
  return `${EXPLORER_BASE}/tx/${hash}`;
}

export function accountExplorerUrl(address: string): string {
  return `${EXPLORER_BASE}/account/${address}`;
}

export function contractExplorerUrl(id: string): string {
  return `${EXPLORER_BASE}/contract/${id}`;
}

export function truncateAddress(address: string | null | undefined, size = 4): string {
  if (!address) return "—";
  if (address.length <= size * 2 + 3) return address;
  return `${address.slice(0, size + 1)}…${address.slice(-size)}`;
}
