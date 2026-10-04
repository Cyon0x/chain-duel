import "server-only";
import { db, nowIso } from "../db";
import {
  addGamePlayer,
  claimQueueEntry,
  closeQueueEntry,
  completeQueueEntriesForGame,
  createGame,
  enqueue,
  expireQueueEntries,
  findActiveQueueEntry,
  findGameById,
  findOpponentInQueue,
  findQueueEntry,
  updateGame,
} from "../db/repositories/duel";
import { findProfile, primaryWallet } from "../db/repositories/identity";
import type { GameRow, GameStatus, QueueRow } from "../db/types";
import { ECONOMY, PULSE_DUEL, QUEUE_TTL_MS, inviteCode } from "../config/game";
import { secureSeed } from "../game/rng";
import { randomContractGameId } from "../auth/stellar";
import { onChainEscrowAvailable } from "./escrow";
import { escrowUnavailableError, ChainDuelError } from "./errors";

export interface QueueSnapshot {
  status: "idle" | "searching" | "matched" | "cancelled" | "expired";
  queueId: string | null;
  gameId: string | null;
  entryStroops: number;
  demo: boolean;
  searchStartedAt: string | null;
  opponent: { username: string; avatar: string | null; rating: number } | null;
}

const PLAYABLE_GAME_STATUSES: GameStatus[] = ["waiting", "joined", "active"];

/**
 * Resolves the duel a queue ticket points at. If that duel already finished,
 * the ticket is released so the player gets a new search instead of being
 * bounced back to a result screen forever.
 */
async function resolveQueuedGame(
  database: Awaited<ReturnType<typeof db>>,
  entry: QueueRow,
): Promise<GameRow | null> {
  if (!entry.game_id) return null;
  const game = await findGameById(database, entry.game_id);
  if (game && PLAYABLE_GAME_STATUSES.includes(game.status)) return game;
  await completeQueueEntriesForGame(database, entry.game_id);
  return null;
}

export async function joinQueue(input: {
  userId: string;
  entryStroops: number;
  demo: boolean;
}): Promise<QueueSnapshot> {
  if (!input.demo && !onChainEscrowAvailable()) throw escrowUnavailableError();
  if (!input.demo) {
    if (
      !Number.isInteger(input.entryStroops) ||
      input.entryStroops < ECONOMY.minEntryStroops ||
      input.entryStroops > ECONOMY.maxEntryStroops
    ) {
      throw new ChainDuelError("That entry is outside the allowed range.", "invalid_entry");
    }
  }

  const database = await db();
  const existing = await findActiveQueueEntry(database, input.userId);
  if (existing) {
    if (!existing.game_id) {
      return {
        status: "searching",
        queueId: existing.id,
        gameId: null,
        entryStroops: existing.entry_stroops,
        demo: existing.demo === 1,
        searchStartedAt: existing.created_at,
        opponent: null,
      };
    }
    const matched = await resolveQueuedGame(database, existing);
    if (matched) {
      return {
        status: "matched",
        queueId: existing.id,
        gameId: matched.id,
        entryStroops: existing.entry_stroops,
        demo: existing.demo === 1,
        searchStartedAt: existing.created_at,
        opponent: null,
      };
    }
    // The previous duel is finished; fall through and open a fresh ticket.
  }

  const entry = await enqueue(database, {
    userId: input.userId,
    gameType: "pulse_duel",
    entryStroops: input.entryStroops,
    demo: input.demo,
    expiresAt: new Date(Date.now() + QUEUE_TTL_MS).toISOString(),
  });

  const paired = await tryPair(input.userId, entry);
  if (paired) return paired;

  return {
    status: "searching",
    queueId: entry.id,
    gameId: null,
    entryStroops: entry.entry_stroops,
    demo: entry.demo === 1,
    searchStartedAt: entry.created_at,
    opponent: null,
  };
}

export async function queueStatus(userId: string): Promise<QueueSnapshot> {
  const database = await db();
  const entry = await findActiveQueueEntry(database, userId);
  if (!entry) {
    return {
      status: "idle",
      queueId: null,
      gameId: null,
      entryStroops: 0,
      demo: false,
      searchStartedAt: null,
      opponent: null,
    };
  }
  if (entry.status === "searching") {
    const paired = await tryPair(userId, entry);
    if (paired) return paired;
  }
  if (entry.game_id) {
    const game = await resolveQueuedGame(database, entry);
    if (!game) {
      return {
        status: "idle",
        queueId: null,
        gameId: null,
        entryStroops: 0,
        demo: false,
        searchStartedAt: null,
        opponent: null,
      };
    }
    return {
      status: "matched",
      queueId: entry.id,
      gameId: game.id,
      entryStroops: entry.entry_stroops,
      demo: entry.demo === 1,
      searchStartedAt: entry.created_at,
      opponent: null,
    };
  }
  return {
    status: entry.status as QueueSnapshot["status"],
    queueId: entry.id,
    gameId: null,
    entryStroops: entry.entry_stroops,
    demo: entry.demo === 1,
    searchStartedAt: entry.created_at,
    opponent: null,
  };
}

export async function cancelQueue(userId: string): Promise<boolean> {
  const database = await db();
  const entry = await findActiveQueueEntry(database, userId);
  if (!entry) return false;
  if (entry.game_id) return false;
  return closeQueueEntry(database, entry.id, "cancelled");
}

/**
 * Atomically pairs two waiting tickets. The compare-and-set claim on both queue
 * rows is what prevents two simultaneous pollers from creating two duels — and
 * nobody is charged at this stage.
 */
async function tryPair(userId: string, entry: QueueRow): Promise<QueueSnapshot | null> {
  const database = await db();
  const opponentEntry = await findOpponentInQueue(database, {
    userId,
    gameType: entry.game_type,
    entryStroops: entry.entry_stroops,
    demo: entry.demo === 1,
  });
  if (!opponentEntry) return null;

  const creatorIsMine = entry.created_at < opponentEntry.created_at;
  const creatorId = creatorIsMine ? entry.user_id : opponentEntry.user_id;
  const joinerId = creatorIsMine ? opponentEntry.user_id : entry.user_id;
  const creatorEntry = creatorIsMine ? entry : opponentEntry;
  const joinerEntry = creatorIsMine ? opponentEntry : entry;

  const game = await createGame(database, {
    code: inviteCode(),
    mode: "pvp",
    visibility: entry.demo === 1 ? "demo" : "public",
    creatorId,
    entryStroops: creatorEntry.entry_stroops,
    feeBps: ECONOMY.feeBps,
    seed: secureSeed(16),
    durationMs: PULSE_DUEL.durationMs,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    escrowState: entry.demo === 1 ? "offchain" : "none",
    demo: entry.demo === 1,
    contractGameId: entry.demo === 1 ? null : randomContractGameId(),
  });

  const claimedMine = await claimQueueEntry(database, entry.id, game.id);
  if (!claimedMine) return null;
  const claimedTheirs = await claimQueueEntry(database, opponentEntry.id, game.id);
  if (!claimedTheirs) {
    await closeQueueEntry(database, entry.id, "cancelled");
    await updateGame(database, game.id, { status: "cancelled" });
    return null;
  }

  const creatorWallet = await primaryWallet(database, creatorId);
  const joinerWallet = await primaryWallet(database, joinerId);
  await addGamePlayer(database, {
    gameId: game.id,
    userId: creatorId,
    seat: 1,
    address: creatorWallet?.address ?? null,
  });
  await addGamePlayer(database, {
    gameId: game.id,
    userId: joinerId,
    seat: 2,
    address: joinerWallet?.address ?? null,
  });
  await updateGame(database, game.id, { opponent_id: joinerId });

  void joinerEntry;
  const myRole = creatorIsMine ? "creator" : "joiner";
  return {
    status: "matched",
    queueId: entry.id,
    gameId: game.id,
    entryStroops: entry.entry_stroops,
    demo: entry.demo === 1,
    searchStartedAt: entry.created_at,
    opponent: await opponentSummary(database, creatorIsMine ? joinerId : creatorId, myRole),
  } as QueueSnapshot;
}

async function opponentSummary(
  database: Awaited<ReturnType<typeof db>>,
  opponentId: string,
  _role: string,
): Promise<QueueSnapshot["opponent"]> {
  const profile = await findProfile(database, opponentId);
  if (!profile) return null;
  return { username: profile.username, avatar: profile.avatar, rating: profile.rating };
}

export async function purgeQueues(): Promise<{ expired: number }> {
  const database = await db();
  const expired = await expireQueueEntries(database, nowIso());
  return { expired };
}

export async function matchedGameIdFor(userId: string): Promise<string | null> {
  const database = await db();
  const entry = await findActiveQueueEntry(database, userId);
  return entry?.game_id ?? null;
}

export async function queueEntryById(queueId: string): Promise<QueueRow | null> {
  const database = await db();
  return findQueueEntry(database, queueId);
}

export function queueGameOf(game: GameRow | null): GameRow | null {
  return game;
}
