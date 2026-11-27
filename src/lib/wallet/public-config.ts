"use client";

import type { StellarPublicConfig } from "../stellar/shared";

let configured: StellarPublicConfig | null = null;
let pending: Promise<StellarPublicConfig> | null = null;

export function configureStellarWallet(value: StellarPublicConfig) {
  configured = value;
}

/** Wallet signing uses server-provided public configuration, with no browser
 * environment fallback to Testnet and no access to signing/encryption secrets. */
export async function walletPublicConfig(): Promise<StellarPublicConfig> {
  if (configured) return configured;
  if (!pending) pending = (async () => {
    const response = await fetch("/api/networks", { cache: "no-store" });
    if (!response.ok) throw new Error("The Stellar network configuration is unavailable.");
    const payload = await response.json() as { stellar?: StellarPublicConfig };
    if (!payload.stellar?.networkPassphrase || !payload.stellar.asset) throw new Error("The Stellar network configuration is invalid.");
    configured = payload.stellar;
    return configured;
  })().catch(error => { pending = null; throw error; });
  return pending;
}
