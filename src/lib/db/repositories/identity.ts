import { newId, nowIso } from "../index";
import type {
  AchievementRow,
  AuthProvider,
  ProfileRow,
  SessionRow,
  SqlDriver,
  UserRow,
  WalletRow,
} from "../types";

const USER_FIELDS = ["primary_wallet", "email", "status", "is_admin", "last_seen_at"] as const;
const PROFILE_FIELDS = [
  "username",
  "username_lower",
  "avatar",
  "theme",
  "onboarding_complete",
  "rating",
  "reputation",
  "wins",
  "losses",
  "games_played",
  "human_games",
  "bot_games",
  "bot_wins",
  "bot_losses",
  "current_streak",
  "best_streak",
  "total_earned_stroops",
  "total_wagered_stroops",
  "fees_paid_stroops",
  "achievements",
] as const;

// -------------------------------------------------------------------- users

export async function findUserById(db: SqlDriver, id: string): Promise<UserRow | null> {
  return db.one<UserRow>("SELECT * FROM users WHERE id = ?", [id]);
}

export async function findUserByWallet(db: SqlDriver, address: string): Promise<UserRow | null> {
  return db.one<UserRow>("SELECT * FROM users WHERE primary_wallet = ?", [address]);
}

export async function findUserByProvider(
  db: SqlDriver,
  provider: AuthProvider,
  providerAccountId: string,
): Promise<UserRow | null> {
  return db.one<UserRow>(
    "SELECT * FROM users WHERE auth_provider = ? AND provider_account_id = ?",
    [provider, providerAccountId],
  );
}

export async function createUser(
  db: SqlDriver,
  input: {
    id?: string;
    primaryWallet?: string | null;
    email?: string | null;
    authProvider: AuthProvider;
    providerAccountId?: string | null;
    isAdmin?: boolean;
  },
): Promise<UserRow> {
  const id = input.id ?? newId("usr");
  const timestamp = nowIso();
  await db.execute(
    `INSERT INTO users (id, primary_wallet, email, auth_provider, provider_account_id, status, is_admin, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    [
      id,
      input.primaryWallet ?? null,
      input.email ?? null,
      input.authProvider,
      input.providerAccountId ?? null,
      input.isAdmin ? 1 : 0,
      timestamp,
      timestamp,
    ],
  );
  const user = await findUserById(db, id);
  if (!user) throw new Error("Failed to create user");
  return user;
}

export async function updateUser(
  db: SqlDriver,
  id: string,
  patch: Partial<Record<(typeof USER_FIELDS)[number], unknown>>,
): Promise<UserRow> {
  const entries = USER_FIELDS.filter((field) => patch[field] !== undefined).map((field) => [
    field,
    patch[field],
  ]) as Array<[string, unknown]>;
  if (entries.length > 0) {
    const assignments = entries.map(([field]) => `${field} = ?`).join(", ");
    await db.execute(`UPDATE users SET ${assignments} WHERE id = ?`, [
      ...entries.map(([, value]) => value),
      id,
    ]);
  }
  const user = await findUserById(db, id);
  if (!user) throw new Error(`User ${id} not found`);
  return user;
}

export async function touchUser(db: SqlDriver, id: string): Promise<void> {
  await db.execute("UPDATE users SET last_seen_at = ? WHERE id = ?", [nowIso(), id]);
}

export async function findAdminUser(db: SqlDriver): Promise<UserRow | null> {
  return db.one<UserRow>("SELECT * FROM users WHERE is_admin = 1 LIMIT 1");
}

// ----------------------------------------------------------------- profiles

export async function createProfile(
  db: SqlDriver,
  input: {
    userId: string;
    username: string;
    avatar?: string | null;
    theme?: string;
    rating?: number;
    reputation?: number;
    onboardingComplete?: boolean;
  },
): Promise<ProfileRow> {
  const timestamp = nowIso();
  await db.execute(
    `INSERT INTO profiles (user_id, username, username_lower, avatar, theme, onboarding_complete, rating, reputation, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.userId,
      input.username,
      input.username.toLowerCase(),
      input.avatar ?? null,
      input.theme ?? "neon",
      input.onboardingComplete ? 1 : 0,
      input.rating ?? 1000,
      input.reputation ?? 100,
      timestamp,
      timestamp,
    ],
  );
  const profile = await findProfile(db, input.userId);
  if (!profile) throw new Error("Failed to create profile");
  return profile;
}

export async function findProfile(db: SqlDriver, userId: string): Promise<ProfileRow | null> {
  return db.one<ProfileRow>("SELECT * FROM profiles WHERE user_id = ?", [userId]);
}

export async function findProfileByUsername(
  db: SqlDriver,
  username: string,
): Promise<ProfileRow | null> {
  return db.one<ProfileRow>("SELECT * FROM profiles WHERE username_lower = ?", [
    username.toLowerCase(),
  ]);
}

export async function usernameTaken(db: SqlDriver, username: string): Promise<boolean> {
  const row = await db.one<{ count: number }>(
    "SELECT COUNT(*) AS count FROM profiles WHERE username_lower = ?",
    [username.toLowerCase()],
  );
  return Number(row?.count ?? 0) > 0;
}

export async function updateProfile(
  db: SqlDriver,
  userId: string,
  patch: Partial<Record<(typeof PROFILE_FIELDS)[number], unknown>>,
): Promise<ProfileRow> {
  const entries = PROFILE_FIELDS.filter((field) => patch[field] !== undefined).map((field) => [
    field,
    patch[field],
  ]) as Array<[string, unknown]>;
  if (entries.length > 0) {
    const assignments = entries.map(([field]) => `${field} = ?`).join(", ");
    await db.execute(
      `UPDATE profiles SET ${assignments}, updated_at = ? WHERE user_id = ?`,
      [...entries.map(([, value]) => value), nowIso(), userId],
    );
  }
  const profile = await findProfile(db, userId);
  if (!profile) throw new Error(`Profile for ${userId} not found`);
  return profile;
}

export interface DirectoryEntry extends ProfileRow {
  is_admin: number;
  online: number;
}

export async function listProfiles(
  db: SqlDriver,
  options: { search?: string; limit?: number; offset?: number; excludeUserId?: string } = {},
): Promise<DirectoryEntry[]> {
  const limit = Math.min(Math.max(options.limit ?? 24, 1), 60);
  const offset = Math.max(options.offset ?? 0, 0);
  const params: unknown[] = [];
  let where = "WHERE 1 = 1";
  if (options.search) {
    where += " AND (p.username_lower LIKE ? OR u.primary_wallet LIKE ?)";
    const needle = `%${options.search.toLowerCase()}%`;
    params.push(needle, `${options.search}%`);
  }
  if (options.excludeUserId) {
    where += " AND p.user_id != ?";
    params.push(options.excludeUserId);
  }
  params.push(limit, offset);
  return db.query<DirectoryEntry>(
    `SELECT p.*, COALESCE(u.is_admin, 0) AS is_admin,
            CASE WHEN u.last_seen_at IS NOT NULL AND u.last_seen_at > ? THEN 1 ELSE 0 END AS online
     FROM profiles p
     LEFT JOIN users u ON u.id = p.user_id
     ${where}
     ORDER BY p.rating DESC, p.games_played DESC
     LIMIT ? OFFSET ?`,
    [new Date(Date.now() - 5 * 60 * 1000).toISOString(), ...params],
  );
}

export async function leaderboard(
  db: SqlDriver,
  options: { limit?: number; offset?: number } = {},
): Promise<ProfileRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);
  return db.query<ProfileRow>(
    `SELECT * FROM profiles
     WHERE games_played > 0
     ORDER BY rating DESC, wins DESC, games_played ASC
     LIMIT ? OFFSET ?`,
    [limit, offset],
  );
}

export async function profileRank(db: SqlDriver, rating: number): Promise<number> {
  const row = await db.one<{ count: number }>(
    "SELECT COUNT(*) AS count FROM profiles WHERE rating > ? AND games_played > 0",
    [rating],
  );
  return Number(row?.count ?? 0) + 1;
}

export async function countProfiles(db: SqlDriver): Promise<number> {
  const row = await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM profiles");
  return Number(row?.count ?? 0);
}

// ------------------------------------------------------------------ wallets

export async function createWallet(
  db: SqlDriver,
  input: {
    userId: string;
    address: string;
    provider: string;
    custody: "external" | "managed";
    isPrimary?: boolean;
    label?: string | null;
    network: string;
  },
): Promise<WalletRow> {
  const id = newId("wal");
  if (input.isPrimary) {
    await db.execute("UPDATE wallets SET is_primary = 0 WHERE user_id = ?", [input.userId]);
  }
  await db.execute(
    `INSERT INTO wallets (id, user_id, address, provider, custody, is_primary, label, network, linked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.userId,
      input.address,
      input.provider,
      input.custody,
      input.isPrimary ? 1 : 0,
      input.label ?? null,
      input.network,
      nowIso(),
    ],
  );
  const wallet = await db.one<WalletRow>("SELECT * FROM wallets WHERE id = ?", [id]);
  if (!wallet) throw new Error("Failed to create wallet");
  return wallet;
}

export async function listWallets(db: SqlDriver, userId: string): Promise<WalletRow[]> {
  return db.query<WalletRow>(
    "SELECT * FROM wallets WHERE user_id = ? ORDER BY is_primary DESC, linked_at ASC",
    [userId],
  );
}

export async function findWalletByAddress(db: SqlDriver, address: string): Promise<WalletRow | null> {
  return db.one<WalletRow>("SELECT * FROM wallets WHERE address = ?", [address]);
}

export async function primaryWallet(db: SqlDriver, userId: string): Promise<WalletRow | null> {
  return db.one<WalletRow>(
    "SELECT * FROM wallets WHERE user_id = ? ORDER BY is_primary DESC, linked_at ASC LIMIT 1",
    [userId],
  );
}

export async function storeWalletKey(
  db: SqlDriver,
  walletId: string,
  secret: { ciphertext: string; iv: string; authTag: string },
): Promise<void> {
  await db.execute(
    `INSERT INTO wallet_keys (wallet_id, ciphertext, iv, auth_tag, algo, created_at)
     VALUES (?, ?, ?, ?, 'aes-256-gcm', ?)`,
    [walletId, secret.ciphertext, secret.iv, secret.authTag, nowIso()],
  );
}

export interface WalletKeyRow {
  wallet_id: string;
  ciphertext: string;
  iv: string;
  auth_tag: string;
  algo: string;
}

export async function loadWalletKey(db: SqlDriver, walletId: string): Promise<WalletKeyRow | null> {
  return db.one<WalletKeyRow>(
    "SELECT wallet_id, ciphertext, iv, auth_tag, algo FROM wallet_keys WHERE wallet_id = ?",
    [walletId],
  );
}

// ----------------------------------------------------------------- sessions

export async function createSession(
  db: SqlDriver,
  input: {
    id: string;
    userId: string;
    tokenHash: string;
    walletAddress: string | null;
    expiresAt: string;
    userAgentHash: string | null;
  },
): Promise<SessionRow> {
  await db.execute(
    `INSERT INTO sessions (id, user_id, token_hash, wallet_address, created_at, expires_at, user_agent_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.userId,
      input.tokenHash,
      input.walletAddress,
      nowIso(),
      input.expiresAt,
      input.userAgentHash,
    ],
  );
  const session = await db.one<SessionRow>("SELECT * FROM sessions WHERE id = ?", [input.id]);
  if (!session) throw new Error("Failed to create session");
  return session;
}

export async function findSession(db: SqlDriver, id: string): Promise<SessionRow | null> {
  return db.one<SessionRow>("SELECT * FROM sessions WHERE id = ?", [id]);
}

export async function revokeSession(db: SqlDriver, id: string): Promise<void> {
  await db.execute("UPDATE sessions SET revoked_at = ? WHERE id = ?", [nowIso(), id]);
}

export async function revokeUserSessions(db: SqlDriver, userId: string): Promise<void> {
  await db.execute("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", [
    nowIso(),
    userId,
  ]);
}

// ------------------------------------------------------------------- nonces

export async function storeNonce(
  db: SqlDriver,
  nonce: string,
  address: string,
  expiresAt: string,
): Promise<void> {
  await db.execute(
    "INSERT INTO stellar_nonces (nonce, address, created_at, expires_at) VALUES (?, ?, ?, ?)",
    [nonce, address, nowIso(), expiresAt],
  );
}

export async function consumeNonce(
  db: SqlDriver,
  nonce: string,
  address: string,
): Promise<boolean> {
  const row = await db.one<{ nonce: string; expires_at: string; consumed_at: string | null }>(
    "SELECT nonce, expires_at, consumed_at FROM stellar_nonces WHERE nonce = ? AND address = ?",
    [nonce, address],
  );
  if (!row || row.consumed_at) return false;
  if (new Date(row.expires_at).getTime() < Date.now()) return false;
  await db.execute("UPDATE stellar_nonces SET consumed_at = ? WHERE nonce = ?", [nowIso(), nonce]);
  return true;
}

// ------------------------------------------------------------- achievements

export async function listAchievements(db: SqlDriver, userId: string): Promise<AchievementRow[]> {
  return db.query<AchievementRow>(
    "SELECT * FROM achievements WHERE user_id = ? ORDER BY unlocked_at IS NULL, unlocked_at DESC",
    [userId],
  );
}

export async function unlockAchievement(
  db: SqlDriver,
  userId: string,
  code: string,
  progress = 100,
): Promise<{ created: boolean }> {
  const existing = await db.one<AchievementRow>(
    "SELECT * FROM achievements WHERE user_id = ? AND code = ?",
    [userId, code],
  );
  if (existing?.unlocked_at) return { created: false };
  if (existing) {
    await db.execute("UPDATE achievements SET progress = ?, unlocked_at = ? WHERE id = ?", [
      progress,
      nowIso(),
      existing.id,
    ]);
    return { created: true };
  }
  await db.execute(
    "INSERT INTO achievements (id, user_id, code, progress, unlocked_at) VALUES (?, ?, ?, ?, ?)",
    [newId("ach"), userId, code, progress, nowIso()],
  );
  return { created: true };
}
