import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { requireSecret } from "../config/env";

/**
 * Managed (embedded) wallet custody for social sign-in.
 *
 * Chain Duel never stores a plaintext secret, never returns one over the API and
 * never exposes it to the browser. Secrets are sealed with AES-256-GCM using a
 * server-held key and only unwrapped inside the signing service.
 *
 * The custody boundary is a single interface (`sealSecret` / `openSecret`) so it
 * can be swapped for a passkey / smart-wallet signer without touching callers.
 */

function encryptionKey(): Buffer {
  const secret = requireSecret("WALLET_ENCRYPTION_KEY");
  return createHash("sha256").update(secret).digest();
}

export interface SealedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export function sealSecret(secret: string): SealedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

export function openSecret(sealed: SealedSecret): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(sealed.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(sealed.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

export interface ManagedWalletMaterial {
  publicKey: string;
  sealed: SealedSecret;
}

export function generateManagedWallet(): ManagedWalletMaterial {
  const keypair = Keypair.random();
  return { publicKey: keypair.publicKey(), sealed: sealSecret(keypair.secret()) };
}

export function managedKeypair(sealed: SealedSecret): Keypair {
  return Keypair.fromSecret(openSecret(sealed));
}
