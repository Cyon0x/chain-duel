import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { createChallenge, isValidStellarAddress, verifyChallenge } from "@/lib/auth/stellar";
import { hashToken } from "@/lib/auth/session";
import { generateManagedWallet, openSecret, sealSecret } from "@/lib/stellar/wallet";
import { validateUsername, RESERVED_USERNAMES } from "@/lib/services/accounts";
import { secureChance, secureSeed, secureToken } from "@/lib/game/rng";
import { inviteCode } from "@/lib/config/game";

function encode(keypair: Keypair, message: string): string {
  return Buffer.from(keypair.sign(Buffer.from(message, "utf8"))).toString("base64");
}

describe("sign-in with stellar", () => {
  it("accepts a real Ed25519 signature over the issued challenge", async () => {
    const keypair = Keypair.random();
    const challenge = await createChallenge(keypair.publicKey());
    const signature = encode(keypair, challenge.message);
    const result = await verifyChallenge({
      address: keypair.publicKey(),
      message: challenge.message,
      signature,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a replayed signature (the nonce is single-use)", async () => {
    const keypair = Keypair.random();
    const challenge = await createChallenge(keypair.publicKey());
    const signature = encode(keypair, challenge.message);
    const first = await verifyChallenge({ address: keypair.publicKey(), message: challenge.message, signature });
    const replay = await verifyChallenge({ address: keypair.publicKey(), message: challenge.message, signature });
    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(false);
    expect(replay.reason).toBe("nonce_invalid_or_used");
  });

  it("rejects a signature from a different key", async () => {
    const victim = Keypair.random();
    const attacker = Keypair.random();
    const challenge = await createChallenge(victim.publicKey());
    const signature = encode(attacker, challenge.message);
    const result = await verifyChallenge({
      address: victim.publicKey(),
      message: challenge.message,
      signature,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("signature_rejected");
  });

  it("rejects a tampered domain", async () => {
    const keypair = Keypair.random();
    const challenge = await createChallenge(keypair.publicKey());
    const tampered = challenge.message.replace("Domain: ", "Domain: https://evil.example");
    const signature = encode(keypair, tampered);
    const result = await verifyChallenge({ address: keypair.publicKey(), message: tampered, signature });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("domain_mismatch");
  });

  it("validates Stellar addresses", () => {
    expect(isValidStellarAddress(Keypair.random().publicKey())).toBe(true);
    expect(isValidStellarAddress("not-an-address")).toBe(false);
    expect(isValidStellarAddress("")).toBe(false);
  });
});

describe("managed wallet custody", () => {
  it("seals and opens a secret without ever storing plaintext", () => {
    const secret = Keypair.random().secret();
    const sealed = sealSecret(secret);
    expect(sealed.ciphertext).not.toContain(secret);
    expect(sealed.ciphertext).not.toBe(secret);
    expect(JSON.stringify(sealed)).not.toContain(secret);
    expect(openSecret(sealed)).toBe(secret);
  });

  it("produces a fresh IV per sealing so ciphertexts differ", () => {
    const secret = Keypair.random().secret();
    expect(sealSecret(secret).ciphertext).not.toBe(sealSecret(secret).ciphertext);
  });

  it("fails to open a tampered ciphertext (authenticated encryption)", () => {
    const material = generateManagedWallet();
    const tampered = { ...material.sealed, ciphertext: Buffer.from("nonsense").toString("base64") };
    expect(() => openSecret(tampered)).toThrow();
  });

  it("never returns a secret from the managed wallet material", () => {
    const material = generateManagedWallet();
    expect(Object.keys(material)).toEqual(["publicKey", "sealed"]);
    const serialized = JSON.stringify(material);
    // A Stellar secret key always starts with S; the serialized material must
    // contain only the public key and ciphertext.
    expect(serialized).not.toMatch(/"S[A-Z2-7]{55}"/);
    expect(serialized).not.toMatch(/secret/i);
    expect(material.publicKey.startsWith("G")).toBe(true);
  });
});

describe("usernames", () => {
  it("accepts sane names and rejects reserved or malformed ones", () => {
    expect(validateUsername("duelist_01").ok).toBe(true);
    expect(validateUsername("ab").ok).toBe(false);
    expect(validateUsername("has space").ok).toBe(false);
    expect(validateUsername("admin").ok).toBe(false);
    for (const reserved of RESERVED_USERNAMES) {
      expect(validateUsername(reserved).ok).toBe(false);
    }
  });
});

describe("randomness + identifiers", () => {
  it("invite codes are uppercase, unambiguous and non-sequential", () => {
    const codes = new Set(Array.from({ length: 400 }, () => inviteCode()));
    expect(codes.size).toBe(400);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z2-9]{6}$/);
      expect(code).not.toMatch(/[IO01]/);
    }
  });

  it("session token hashes are stable and not reversible", () => {
    const token = secureToken(32);
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toBe(token);
    expect(hashToken(token)).toHaveLength(64);
  });

  it("game seeds and tokens are CSPRNG-derived and unique", () => {
    const seeds = new Set(Array.from({ length: 200 }, () => secureSeed(16)));
    expect(seeds.size).toBe(200);
    const rolls = Array.from({ length: 500 }, () => secureChance(0.5));
    const trues = rolls.filter(Boolean).length;
    expect(trues).toBeGreaterThan(180);
    expect(trues).toBeLessThan(320);
  });
});
