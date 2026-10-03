import "server-only";
import { Keypair } from "@stellar/stellar-sdk";
import { db, newId } from "../db";
import { consumeNonce, storeNonce } from "../db/repositories/identity";
import { appUrl } from "../config/env";
import { stellarNetwork } from "../config/stellar";
import { secureToken } from "../game/rng";

const CHALLENGE_TTL_MS = 10 * 60 * 1000;

export interface StellarChallenge {
  message: string;
  expiresAt: string;
}

/**
 * Sign-In With Stellar. The server issues a single-use, expiring, domain-bound
 * challenge; the wallet signs the exact UTF-8 bytes; the server verifies the
 * Ed25519 signature against the claimed public key and burns the nonce.
 */
export async function createChallenge(address: string): Promise<StellarChallenge> {
  const nonce = secureToken(24);
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
  const net = stellarNetwork();
  const message = [
    "Chain Duel — Sign-In With Stellar",
    `Domain: ${appUrl()}`,
    `Network: ${net.label}`,
    `Address: ${address}`,
    `Nonce: ${nonce}`,
    `Issued: ${new Date().toISOString()}`,
  ].join("\n");

  const database = await db();
  await storeNonce(database, nonce, address, expiresAt);
  return { message, expiresAt };
}

export interface VerifyChallengeInput {
  address: string;
  message: string;
  signature: string;
  signerAddress?: string | null;
}

function decodeSignature(signature: string): Buffer | null {
  const trimmed = signature.trim();
  if (/^[0-9a-fA-F]{128}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  try {
    const buffer = Buffer.from(trimmed, "base64");
    if (buffer.length === 64) return buffer;
  } catch {
    return null;
  }
  return null;
}

export async function verifyChallenge(input: VerifyChallengeInput): Promise<{ ok: boolean; reason?: string }> {
  if (input.signerAddress && input.signerAddress !== input.address) {
    return { ok: false, reason: "signer_mismatch" };
  }
  const nonceLine = input.message
    .split("\n")
    .find((line) => line.startsWith("Nonce: "));
  if (!nonceLine) return { ok: false, reason: "malformed_challenge" };
  const nonce = nonceLine.slice("Nonce: ".length).trim();
  if (!input.message.includes(`Domain: ${appUrl()}`)) {
    return { ok: false, reason: "domain_mismatch" };
  }
  const database = await db();
  const consumed = await consumeNonce(database, nonce, input.address);
  if (!consumed) return { ok: false, reason: "nonce_invalid_or_used" };

  const signature = decodeSignature(input.signature);
  if (!signature) return { ok: false, reason: "invalid_signature_encoding" };
  try {
    const keypair = Keypair.fromPublicKey(input.address);
    const valid = keypair.verify(Buffer.from(input.message, "utf8"), signature);
    return valid ? { ok: true } : { ok: false, reason: "signature_rejected" };
  } catch {
    return { ok: false, reason: "invalid_public_key" };
  }
}

export function isValidStellarAddress(address: string): boolean {
  try {
    const keypair = Keypair.fromPublicKey(address);
    return keypair.publicKey() === address;
  } catch {
    return false;
  }
}

export function randomContractGameId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function newNonce(): string {
  return newId("non");
}
