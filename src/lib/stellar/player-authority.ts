import type { PublicStellarVault } from "../wallet/vault-types";

export interface StellarAccountAuthority {
  account_id: string; sequence: string; subentry_count: number; balance?: string;
  thresholds: { low_threshold: number; med_threshold: number; high_threshold: number };
  signers: { key: string; weight: number; type: string }[];
}
/** Exact reviewed authority: no old master or unrelated weighted signer. */
export function delegatedPlayerAuthority(account: StellarAccountAuthority, vault: PublicStellarVault): boolean {
  const signers = account.signers.filter(signer => signer.weight > 0);
  return vault.kind === "delegated-recovery" && account.account_id === vault.walletAddress &&
    account.thresholds.low_threshold === 1 && account.thresholds.med_threshold === 1 && account.thresholds.high_threshold === 1 &&
    !account.signers.some(signer => signer.key === vault.walletAddress && signer.weight > 0) && signers.length === 2 &&
    signers.every(signer => signer.type === "ed25519_public_key" && signer.weight === 1 && [vault.deviceSignerAddress, vault.recoverySignerAddress].includes(signer.key)) &&
    new Set(signers.map(signer => signer.key)).size === 2;
}
export function hasAccountSigningWeight(account: StellarAccountAuthority, signer: string): boolean {
  const entry = account.signers.find(value => value.key === signer && value.type === "ed25519_public_key");
  return Boolean(entry && entry.weight > 0 && entry.weight >= Math.max(1, account.thresholds.med_threshold));
}
