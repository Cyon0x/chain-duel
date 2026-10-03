import "server-only";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { createHash } from "node:crypto";
import { db, newId } from "../db";
import { createSession, findSession, revokeSession, findUserById, findProfile, listWallets } from "../db/repositories/identity";
import type { ProfileRow, UserRow, WalletRow } from "../db/types";
import { requireSecret, isProduction } from "../config/env";

export const SESSION_COOKIE = "cd_session";
const SESSION_TTL_DAYS = 30;

function secretKey(): Uint8Array {
  return new TextEncoder().encode(requireSecret("SESSION_SECRET"));
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface SessionPayload {
  sid: string;
  uid: string;
  wallet: string | null;
}

export async function issueSession(input: {
  userId: string;
  walletAddress: string | null;
  userAgent?: string | null;
}): Promise<{ token: string; sessionId: string; expiresAt: string }> {
  const database = await db();
  const sessionId = newId("ses");
  const token = newId("tok") + newId("tok");
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  await createSession(database, {
    id: sessionId,
    userId: input.userId,
    tokenHash: hashToken(token),
    walletAddress: input.walletAddress,
    expiresAt,
    userAgentHash: input.userAgent ? hashToken(input.userAgent) : null,
  });

  const jwt = await new SignJWT({ uid: input.userId, sid: sessionId, wallet: input.walletAddress })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_DAYS}d`)
    .setSubject(input.userId)
    .sign(secretKey());

  const store = await cookies();
  store.set(SESSION_COOKIE, jwt, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    path: "/",
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
  });

  return { token: jwt, sessionId, expiresAt };
}

export async function readSessionPayload(): Promise<SessionPayload | null> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  try {
    const { payload } = await jwtVerify(raw, secretKey(), { algorithms: ["HS256"] });
    if (!payload.uid || !payload.sid) return null;
    return {
      uid: String(payload.uid),
      sid: String(payload.sid),
      wallet: payload.wallet ? String(payload.wallet) : null,
    };
  } catch {
    return null;
  }
}

export interface SessionUser {
  user: UserRow;
  profile: ProfileRow | null;
  wallets: WalletRow[];
  primaryWallet: WalletRow | null;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const payload = await readSessionPayload();
  if (!payload) return null;
  const database = await db();
  const session = await findSession(database, payload.sid);
  if (!session || session.revoked_at) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) return null;
  const user = await findUserById(database, session.user_id);
  if (!user || user.status !== "active") return null;
  const [profile, wallets] = await Promise.all([
    findProfile(database, user.id),
    listWallets(database, user.id),
  ]);
  return {
    user,
    profile,
    wallets,
    primaryWallet: wallets.find((wallet) => wallet.is_primary === 1) ?? wallets[0] ?? null,
  };
}

export async function requireSessionUser(): Promise<SessionUser> {
  const session = await getSessionUser();
  if (!session) {
    throw new Error("UNAUTHENTICATED");
  }
  return session;
}

export async function destroySession(): Promise<void> {
  const payload = await readSessionPayload();
  if (payload) {
    const database = await db();
    await revokeSession(database, payload.sid);
  }
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}
