import type { StellarNetworkId } from "../stellar/shared";

export type VaultKind = "client-primary" | "delegated-recovery";

/** Ciphertext and public metadata only. No signing or recovery secret. */
export interface StellarRecoveryEnvelope {
  version: 1;
  algorithm: "HKDF-SHA256/AES-256-GCM";
  walletAddress: string;
  signerAddress: string;
  publicKeyHex: string;
  network: StellarNetworkId;
  kind: VaultKind;
  saltHex: string;
  nonceHex: string;
  ciphertextBase64: string;
}

export interface PublicStellarVault {
  version: 1;
  walletAddress: string;
  deviceSignerAddress: string;
  recoverySignerAddress: string;
  network: StellarNetworkId;
  kind: VaultKind;
  recoveryEnvelope: StellarRecoveryEnvelope;
}

export type StellarVaultStatus = "client-primary" | "awaiting-migration-review" | "client-delegated";

export interface StellarVaultView {
  enabled: boolean;
  walletAddress: string | null;
  provider: string | null;
  custody: "external" | "managed" | null;
  network: StellarNetworkId;
  status: StellarVaultStatus | null;
  publicVault: PublicStellarVault | null;
}

/** Canonical public-only enrollment bytes shared by browser and API. */
export function vaultRegistrationMessage(challenge: string, vault: PublicStellarVault): Uint8Array<ArrayBuffer> {
  const envelope = vault.recoveryEnvelope;
  return new TextEncoder().encode(`ChainDuel:PlayerVault:v1\0${challenge}\0${JSON.stringify({
    version: vault.version, walletAddress: vault.walletAddress, deviceSignerAddress: vault.deviceSignerAddress,
    recoverySignerAddress: vault.recoverySignerAddress, network: vault.network, kind: vault.kind,
    recoveryEnvelope: { version: envelope.version, algorithm: envelope.algorithm, walletAddress: envelope.walletAddress,
      signerAddress: envelope.signerAddress, publicKeyHex: envelope.publicKeyHex, network: envelope.network,
      kind: envelope.kind, saltHex: envelope.saltHex, nonceHex: envelope.nonceHex, ciphertextBase64: envelope.ciphertextBase64 },
  })}`);
}
