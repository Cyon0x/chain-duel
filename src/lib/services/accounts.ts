import "server-only";
import { db, newId } from "../db";
import {
  createProfile,
  createUser,
  createWallet,
  findProfile,
  findUserByProvider,
  findUserByWallet,
  primaryWallet,
  storeWalletKey,
  updateProfile,
  updateUser,
  usernameTaken,
} from "../db/repositories/identity";
import { generateManagedWallet } from "../stellar/wallet";
import { stellarNetwork } from "../config/stellar";
import { rawEnv } from "../config/env";
import type { AuthProvider, UserRow } from "../db/types";
import type { SessionUser } from "../auth/session";
import { getSessionUser } from "../auth/session";

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,18}$/;
export const RESERVED_USERNAMES = new Set([
  "admin",
  "chainduel",
  "chain_duel",
  "system",
  "vex",
  "computer",
  "official",
  "support",
  "root",
  "null",
  "undefined",
]);

export function validateUsername(username: string): { ok: true; value: string } | { ok: false; reason: string } {
  const value = username.trim();
  if (!USERNAME_PATTERN.test(value)) {
    return { ok: false, reason: "Use 3–18 letters, numbers or underscores." };
  }
  if (RESERVED_USERNAMES.has(value.toLowerCase())) {
    return { ok: false, reason: "That name is reserved." };
  }
  return { ok: true, value };
}

function slugify(input: string): string {
  const cleaned = input.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 14);
  return cleaned.length >= 3 ? cleaned : `duelist${cleaned}`;
}

async function uniqueUsername(base: string): Promise<string> {
  const database = await db();
  const seed = slugify(base) || "duelist";
  let candidate = seed.slice(0, 18);
  let attempt = 0;
  while (await usernameTaken(database, candidate)) {
    attempt += 1;
    candidate = `${seed.slice(0, 14)}${attempt}`.slice(0, 18);
    if (attempt > 60) {
      candidate = `${seed.slice(0, 8)}${Math.floor(Math.random() * 1_000_000)}`.slice(0, 18);
    }
  }
  return candidate;
}

function isAdminWallet(address: string | null | undefined): boolean {
  const configured = rawEnv().ADMIN_WALLET_ADDRESS;
  if (!configured || !address) return false;
  return configured.trim() === address.trim();
}

/** Creates or resumes an account for a real Stellar wallet (Freighter, xBull, …). */
export async function signInWithWallet(address: string): Promise<{ userId: string; created: boolean }> {
  const database = await db();
  const existing = await findUserByWallet(database, address);
  if (existing) {
    await updateUser(database, existing.id, {
      last_seen_at: new Date().toISOString(),
      is_admin: isAdminWallet(address) ? 1 : existing.is_admin,
    });
    const profile = await findProfile(database, existing.id);
    if (!profile) {
      await createProfile(database, { userId: existing.id, username: await uniqueUsername(address.slice(1, 9)) });
    }
    return { userId: existing.id, created: false };
  }

  const user = await createUser(database, {
    primaryWallet: address,
    authProvider: "stellar",
    providerAccountId: address,
    isAdmin: isAdminWallet(address),
  });
  await createWallet(database, {
    userId: user.id,
    address,
    provider: "stellar-wallet",
    custody: "external",
    isPrimary: true,
    network: stellarNetwork().id,
  });
  await createProfile(database, { userId: user.id, username: await uniqueUsername(address.slice(1, 9)) });
  return { userId: user.id, created: true };
}

/**
 * Social sign-in. A managed Stellar wallet is provisioned with the secret sealed
 * under AES-256-GCM. The secret never leaves the server signing service.
 */
export async function signInWithProvider(input: {
  provider: Extract<AuthProvider, "google" | "x">;
  providerAccountId: string;
  email?: string | null;
  displayName?: string | null;
  avatar?: string | null;
}): Promise<{ userId: string; created: boolean }> {
  const database = await db();
  const existing = await findUserByProvider(database, input.provider, input.providerAccountId);
  if (existing) {
    await updateUser(database, existing.id, { last_seen_at: new Date().toISOString() });
    const profile = await findProfile(database, existing.id);
    if (!profile) {
      await createProfile(database, {
        userId: existing.id,
        username: await uniqueUsername(input.displayName ?? input.email ?? "duelist"),
        avatar: input.avatar ?? null,
      });
    }
    return { userId: existing.id, created: false };
  }

  const user = await createUser(database, {
    email: input.email ?? null,
    authProvider: input.provider,
    providerAccountId: input.providerAccountId,
  });
  await provisionManagedWallet(database, user.id);
  await createProfile(database, {
    userId: user.id,
    username: await uniqueUsername(input.displayName ?? input.email ?? "duelist"),
    avatar: input.avatar ?? null,
  });
  return { userId: user.id, created: true };
}

/** Sandbox/demo identity: real account + real wallet address, no funding required. */
export async function signInDemo(displayName?: string): Promise<{ userId: string; created: boolean }> {
  const database = await db();
  const user = await createUser(database, { authProvider: "demo", providerAccountId: newId("demo") });
  await provisionManagedWallet(database, user.id);
  await createProfile(database, {
    userId: user.id,
    username: await uniqueUsername(displayName ?? "recruit"),
    onboardingComplete: false,
  });
  return { userId: user.id, created: true };
}

export async function provisionManagedWallet(
  database: Awaited<ReturnType<typeof db>>,
  userId: string,
): Promise<string> {
  const material = generateManagedWallet();
  const wallet = await createWallet(database, {
    userId,
    address: material.publicKey,
    provider: "chain-duel-managed",
    custody: "managed",
    isPrimary: true,
    label: "Chain Duel wallet",
    network: stellarNetwork().id,
  });
  await storeWalletKey(database, wallet.id, material.sealed);
  await updateUser(database, userId, { primary_wallet: material.publicKey });
  return material.publicKey;
}

export async function completeOnboarding(
  userId: string,
  input: { username: string; avatar?: string | null; theme?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const database = await db();
  const validated = validateUsername(input.username);
  if (!validated.ok) return { ok: false, error: validated.reason };
  const taken = await usernameTaken(database, validated.value);
  const profile = await findProfile(database, userId);
  if (taken && profile?.username_lower !== validated.value.toLowerCase()) {
    return { ok: false, error: "That username is already taken." };
  }
  await updateProfile(database, userId, {
    username: validated.value,
    username_lower: validated.value.toLowerCase(),
    avatar: input.avatar ?? profile?.avatar ?? null,
    theme: input.theme ?? profile?.theme ?? "neon",
    onboarding_complete: 1,
  });
  return { ok: true };
}

export async function loadAccount(): Promise<SessionUser | null> {
  return getSessionUser();
}

export async function accountWalletAddress(user: UserRow): Promise<string | null> {
  if (user.primary_wallet) return user.primary_wallet;
  const database = await db();
  const wallet = await primaryWallet(database, user.id);
  return wallet?.address ?? null;
}
