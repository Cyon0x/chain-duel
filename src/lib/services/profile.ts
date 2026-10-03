import "server-only";
import { db } from "../db";
import {
  findProfile,
  findProfileByUsername,
  leaderboard as leaderboardQuery,
  listAchievements,
  listProfiles,
  primaryWallet,
  profileRank,
  updateProfile,
} from "../db/repositories/identity";
import {
  countMatchesForUser,
  listActiveGamesForUser,
  listMatchesForUser,
  listRecentGamesForUser,
} from "../db/repositories/duel";
import { listTransactionsForUser } from "../db/repositories/economy";
import type { GameRow, MatchRow, ProfileRow, TransactionRow, WalletRow } from "../db/types";
import { ACHIEVEMENTS } from "../game/rating";
import { getAccountBalance } from "../stellar/server";
import { onChainEscrowAvailable } from "./escrow";
import { botAvailability } from "./treasury";
import type { SessionUser } from "../auth/session";

export interface AchievementView {
  code: string;
  name: string;
  description: string;
  icon: string;
  unlocked: boolean;
}

function achievementViews(unlockedCodes: Set<string>): AchievementView[] {
  return ACHIEVEMENTS.map((definition) => ({
    ...definition,
    unlocked: unlockedCodes.has(definition.code),
  }));
}

export interface DashboardData {
  profile: ProfileRow;
  wallet: WalletRow | null;
  balanceXlm: string | null;
  rank: number;
  recentMatches: MatchRow[];
  activeGames: GameRow[];
  transactions: TransactionRow[];
  achievements: AchievementView[];
  bot: { available: boolean; reason?: string };
  escrowAvailable: boolean;
}

export async function dashboardFor(session: SessionUser): Promise<DashboardData> {
  const database = await db();
  const userId = session.user.id;
  const profile = session.profile ?? (await findProfile(database, userId));
  if (!profile) throw Object.assign(new Error("Profile missing"), { code: "profile_missing" });

  const wallet = await primaryWallet(database, userId);
  const [matches, activeGames, transactions, achievements, rank] = await Promise.all([
    listMatchesForUser(database, userId, { limit: 6 }),
    listActiveGamesForUser(database, userId),
    listTransactionsForUser(database, userId, { limit: 6 }),
    listAchievements(database, userId),
    profileRank(database, profile.rating),
  ]);

  let balanceXlm: string | null = null;
  if (wallet) {
    try {
      balanceXlm = (await getAccountBalance(wallet.address)).xlm;
    } catch {
      balanceXlm = null;
    }
  }

  const bot = await botAvailability(50_000_000).catch(() => ({
    available: false,
    reason: "Computer matches are temporarily unavailable.",
    botLiquidityStroops: 0,
    dailyLiabilityStroops: 0,
    maxDailyLiabilityStroops: 0,
  }));

  return {
    profile,
    wallet,
    balanceXlm,
    rank,
    recentMatches: matches,
    activeGames,
    transactions,
    achievements: achievementViews(
      new Set(achievements.filter((entry) => entry.unlocked_at).map((entry) => entry.code)),
    ),
    bot: { available: bot.available, reason: bot.reason },
    escrowAvailable: onChainEscrowAvailable(),
  };
}

export interface PublicProfile {
  profile: ProfileRow;
  walletAddress: string | null;
  rank: number;
  matches: MatchRow[];
  recentGames: GameRow[];
  achievements: AchievementView[];
  isSelf: boolean;
}

export async function publicProfile(
  username: string,
  viewerId: string | null,
): Promise<PublicProfile | null> {
  const database = await db();
  const profile = await findProfileByUsername(database, username);
  if (!profile) return null;
  const wallet = await primaryWallet(database, profile.user_id);
  const [rank, matches, recentGames, achievements] = await Promise.all([
    profileRank(database, profile.rating),
    listMatchesForUser(database, profile.user_id, { limit: 10 }),
    listRecentGamesForUser(database, profile.user_id, 6),
    listAchievements(database, profile.user_id),
  ]);
  return {
    profile,
    walletAddress: wallet?.address ?? null,
    rank,
    matches,
    recentGames,
    achievements: achievementViews(
      new Set(achievements.filter((entry) => entry.unlocked_at).map((entry) => entry.code)),
    ),
    isSelf: viewerId === profile.user_id,
  };
}

export async function directory(input: {
  search?: string;
  limit?: number;
  offset?: number;
  viewerId?: string | null;
}) {
  const database = await db();
  return listProfiles(database, {
    search: input.search,
    limit: input.limit,
    offset: input.offset,
    excludeUserId: input.viewerId ?? undefined,
  });
}

export async function leaderboard(options: { limit?: number; offset?: number } = {}) {
  const database = await db();
  const rows = await leaderboardQuery(database, options);
  return rows.map((row, index) => ({ ...row, position: (options.offset ?? 0) + index + 1 }));
}

export async function matchHistory(userId: string, mode?: "bot" | "pvp" | "private") {
  const database = await db();
  const rows = await listMatchesForUser(database, userId, { limit: 50, mode });
  return { matches: rows, total: await countMatchesForUser(database, userId) };
}

export async function transactionsFor(userId: string, limit = 50) {
  const database = await db();
  return listTransactionsForUser(database, userId, { limit });
}

export async function updatePreferences(
  userId: string,
  patch: { theme?: string; avatar?: string | null },
): Promise<ProfileRow> {
  const database = await db();
  return updateProfile(database, userId, { theme: patch.theme, avatar: patch.avatar });
}
