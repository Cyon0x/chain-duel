import { beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  cancelDuel,
  commitEntry,
  createDuel,
  joinDuel,
  openDuels,
} from "@/lib/services/duel";
import { settleMatch, startMatch, submitResult } from "@/lib/services/match";
import { completeOnboarding, signInWithWallet } from "@/lib/services/accounts";
import { botAvailability } from "@/lib/services/treasury";
import { requireAdmin, withdrawTreasury } from "@/lib/services/admin";
import { joinQueue, queueStatus } from "@/lib/services/matchmaking";
import { PulseDuelSession, buildTargetSchedule } from "@/lib/game/pulse";
import { findGameById, listGamePlayers } from "@/lib/db/repositories/duel";
import { db } from "@/lib/db";

const ENTRY = 50_000_000;

let alice = "";
let bob = "";
let carol = "";
let aliceName = "";
let bobName = "";

async function makeUser(prefix: string) {
  const keypair = Keypair.random();
  const { userId } = await signInWithWallet(keypair.publicKey());
  const username = `${prefix}${Math.floor(Math.random() * 900_000 + 100_000)}`;
  const result = await completeOnboarding(userId, { username, theme: "neon" });
  expect(result.ok).toBe(true);
  return { userId, username };
}

function eventLog(seed: string, durationMs: number, limit?: number) {
  const schedule = buildTargetSchedule(seed, durationMs);
  const targets = schedule.filter((target) => target.points > 0);
  const chosen = limit ? targets.slice(0, limit) : targets;
  const hits = chosen.map((target) => ({ targetId: target.id, atMs: target.spawnAtMs + 160 }));
  return { hits, misses: [] as Array<{ atMs: number }> };
}

beforeAll(async () => {
  const a = await makeUser("alice");
  alice = a.userId;
  aliceName = a.username;
  const b = await makeUser("bob");
  bob = b.userId;
  bobName = b.username;
  const c = await makeUser("carol");
  carol = c.userId;
});

describe("duel lifecycle (demo)", () => {
  it("creates a private duel with the creator in seat 1", async () => {
    const creation = await createDuel({ userId: alice, mode: "private", entryStroops: ENTRY, demo: true });
    expect(creation.game.status).toBe("waiting");
    expect(creation.game.demo).toBe(1);
    expect(creation.escrow.mode).toBe("offchain");
    expect(creation.invite).not.toBeNull();
    const players = await listGamePlayers(await db(), creation.game.id);
    expect(players).toHaveLength(1);
    expect(players[0].seat).toBe(1);
  });

  it("refuses to let a player duel themselves", async () => {
    const creation = await createDuel({ userId: alice, mode: "private", entryStroops: ENTRY, demo: true });
    await expect(joinDuel({ userId: alice, gameId: creation.game.id })).rejects.toThrow(/yourself/i);
  });

  it("refuses a third player once the duel is full", async () => {
    const creation = await createDuel({ userId: alice, mode: "private", entryStroops: ENTRY, demo: true });
    await joinDuel({ userId: bob, gameId: creation.game.id });
    await expect(joinDuel({ userId: carol, gameId: creation.game.id })).rejects.toThrow(
      /no longer open|already full/i,
    );
  });

  it("runs the full duel, verifies both event logs and settles exactly once", async () => {
    const creation = await createDuel({ userId: alice, mode: "private", entryStroops: ENTRY, demo: true });
    const gameId = creation.game.id;
    const joined = await joinDuel({ userId: bob, gameId });
    expect(joined.game.status).toBe("joined");

    const started = await startMatch({ gameId, userId: alice });
    expect(started.status).toBe("active");

    // Starting twice is a no-op, never a second countdown.
    const again = await startMatch({ gameId, userId: bob });
    expect(again.status).toBe("active");
    expect(again.started_at).toBe(started.started_at);

    const aliceLog = eventLog(started.seed, started.duration_ms);
    const bobLog = eventLog(started.seed, started.duration_ms, 4);

    const aliceScore = aliceLog.hits.length; // not the real score, just optimistic
    const first = await submitResult({
      gameId,
      userId: alice,
      payload: { seat: 1, hits: aliceLog.hits, misses: [], clientScore: 0 },
    }).catch((error: unknown) => error as Error);
    expect(first).toBeInstanceOf(Error);
    expect(String((first as Error).message)).toMatch(/verify/i);

    const aliceResult = await submitResult({
      gameId,
      userId: alice,
      payload: {
        seat: 1,
        hits: aliceLog.hits,
        misses: [],
        clientScore: scoreOf(started.seed, started.duration_ms, aliceLog.hits),
        clientDurationMs: started.duration_ms,
      },
    });
    expect(aliceResult.settled).toBe(false);

    const bobResult = await submitResult({
      gameId,
      userId: bob,
      payload: {
        seat: 2,
        hits: bobLog.hits,
        misses: [],
        clientScore: scoreOf(started.seed, started.duration_ms, bobLog.hits),
        clientDurationMs: started.duration_ms,
      },
    });
    expect(bobResult.settled).toBe(true);
    expect(bobResult.game.status).toBe("settled");
    expect(bobResult.game.winner_id).toBe(alice);
    expect(bobResult.game.player_one_score).toBeGreaterThanOrEqual(bobResult.game.player_two_score);

    // Settlement is idempotent: a retry returns the same settled game.
    const settledAgain = await settleMatch(gameId);
    expect(settledAgain.status).toBe("settled");
    expect(settledAgain.settled_at).toBe(bobResult.game.settled_at);
    expect(settledAgain.winner_id).toBe(alice);

    // A late submission is refused outright.
    await expect(
      submitResult({
        gameId,
        userId: bob,
        payload: { seat: 2, hits: bobLog.hits, misses: [], clientScore: 0 },
      }),
    ).rejects.toThrow(/already settled/i);

    void aliceScore;
  });

  it("rejects a submission from someone who is not in the duel", async () => {
    const creation = await createDuel({ userId: alice, mode: "private", entryStroops: ENTRY, demo: true });
    await joinDuel({ userId: bob, gameId: creation.game.id });
    await startMatch({ gameId: creation.game.id, userId: alice });
    await expect(
      submitResult({ gameId: creation.game.id, userId: carol, payload: { seat: 1, hits: [], misses: [], clientScore: 0 } }),
    ).rejects.toThrow(/not part of this duel/i);
  });

  it("cancels an unjoined duel and refuses to start it", async () => {
    const creation = await createDuel({ userId: alice, mode: "private", entryStroops: ENTRY, demo: true });
    const cancelled = await cancelDuel({ userId: alice, gameId: creation.game.id });
    expect(cancelled.status).toBe("cancelled");
    await expect(startMatch({ gameId: creation.game.id, userId: alice })).rejects.toThrow(/escrow|not ready/i);
  });

  it("does not list private duels in the public queue", async () => {
    const creation = await createDuel({ userId: alice, mode: "private", entryStroops: ENTRY, demo: true });
    const open = await openDuels(50);
    expect(open.find((game) => game.id === creation.game.id)).toBeUndefined();
  });
});

describe("matchmaking", () => {
  it("releases the queue ticket when the duel finishes so play again starts a fresh search", async () => {
    const x = await makeUser("queuex");
    const y = await makeUser("queuey");

    const first = await joinQueue({ userId: x.userId, entryStroops: ENTRY, demo: true });
    expect(first.status).toBe("searching");
    expect(first.gameId).toBeNull();

    const second = await joinQueue({ userId: y.userId, entryStroops: ENTRY, demo: true });
    expect(second.status).toBe("matched");
    const gameId = second.gameId;
    expect(gameId).toBeTruthy();

    // Both players are pointed at the same duel.
    expect((await queueStatus(x.userId)).status).toBe("matched");
    expect((await queueStatus(x.userId)).gameId).toBe(gameId);

    const database = await db();
    const game = await findGameById(database, gameId!);
    expect(game).toBeTruthy();

    await commitEntry({ game: game!, userId: x.userId, role: "creator" });
    await commitEntry({ game: game!, userId: y.userId, role: "joiner" });

    const started = await startMatch({ gameId: gameId!, userId: x.userId });
    expect(started.status).toBe("active");

    const xLog = eventLog(started.seed, started.duration_ms);
    const yLog = eventLog(started.seed, started.duration_ms, 3);
    await submitResult({
      gameId: gameId!,
      userId: x.userId,
      payload: { seat: 1, hits: xLog.hits, misses: [], clientScore: scoreOf(started.seed, started.duration_ms, xLog.hits) },
    });
    const settled = await submitResult({
      gameId: gameId!,
      userId: y.userId,
      payload: { seat: 2, hits: yLog.hits, misses: [], clientScore: scoreOf(started.seed, started.duration_ms, yLog.hits) },
    });
    expect(settled.settled).toBe(true);

    // The finished duel must no longer be offered as a live match.
    expect((await queueStatus(x.userId)).status).toBe("idle");
    expect((await queueStatus(x.userId)).gameId).toBeNull();

    // "Play again" opens a genuinely new search, not the same finished duel.
    const again = await joinQueue({ userId: x.userId, entryStroops: ENTRY, demo: true });
    expect(again.status).toBe("searching");
    expect(again.gameId).toBeNull();
    expect(again.queueId).not.toBe(first.queueId);
  });
});

describe("computer duels", () => {
  it("runs a demo bot duel where the computer actually plays", async () => {
    const creation = await createDuel({ userId: bob, mode: "bot", entryStroops: ENTRY, demo: true });
    expect(creation.bot?.name).toBeTruthy();
    const gameId = creation.game.id;
    const players = await listGamePlayers(await db(), gameId);
    expect(players.some((player) => player.is_bot === 1)).toBe(true);

    // The human entry is committed first; a bot duel is fully funded once the
    // player's side is locked because the treasury covers the computer.
    const committed = await commitEntry({ game: creation.game, userId: bob, role: "creator" });
    expect(committed.game.status).toBe("joined");

    const started = await startMatch({ gameId, userId: bob });
    expect(started.status).toBe("active");

    const log = eventLog(started.seed, started.duration_ms, 3);
    const result = await submitResult({
      gameId,
      userId: bob,
      payload: {
        seat: 1,
        hits: log.hits,
        misses: [],
        clientScore: scoreOf(started.seed, started.duration_ms, log.hits),
      },
    });
    expect(result.settled).toBe(true);
    const botPlayer = (await listGamePlayers(await db(), gameId)).find((player) => player.is_bot === 1)!;
    expect(botPlayer.score).toBeGreaterThan(0);
    expect(botPlayer.result).toBe("finished");
  });

  it("refuses a staked computer duel when the contract is not configured", async () => {
    await expect(
      createDuel({ userId: bob, mode: "bot", entryStroops: ENTRY, demo: false }),
    ).rejects.toThrow(/contract|escrow|unavailable/i);
  });

  it("reports honest bot availability without a contract", async () => {
    const availability = await botAvailability(ENTRY);
    expect(availability.available).toBe(false);
    expect(availability.reason).toBeTruthy();
  });
});

describe("staked duels refuse to fake the blockchain", () => {
  it("will not create a staked duel without on-chain escrow", async () => {
    await expect(
      createDuel({ userId: alice, mode: "private", entryStroops: ENTRY, demo: false }),
    ).rejects.toThrow(/escrow/i);
  });

  it("will not start a staked duel whose escrow is not on chain", async () => {
    const creation = await createDuel({ userId: alice, mode: "private", entryStroops: ENTRY, demo: true });
    await joinDuel({ userId: bob, gameId: creation.game.id });
    const database = await db();
    const game = await findGameById(database, creation.game.id);
    // Simulate a game that was marked as a real duel but never funded.
    await database.execute("UPDATE games SET demo = 0, escrow_state = 'none' WHERE id = ?", [creation.game.id]);
    expect(game?.demo).toBe(1);
    await expect(startMatch({ gameId: creation.game.id, userId: alice })).rejects.toThrow(/escrow/i);
  });
});

describe("admin authorization", () => {
  it("denies treasury access to a normal player", async () => {
    await expect(requireAdmin(alice)).rejects.toThrow(/administrator/i);
    await expect(withdrawTreasury({ userId: alice, amountStroops: 1_000_000 })).rejects.toThrow(/administrator/i);
  });

  it("denies treasury access to a random wallet that is not the admin", async () => {
    await expect(requireAdmin(carol)).rejects.toThrow(/administrator/i);
    await expect(withdrawTreasury({ userId: carol, amountStroops: 1 })).rejects.toThrow(/administrator/i);
  });
});

function scoreOf(seed: string, durationMs: number, hits: Array<{ targetId: number; atMs: number }>): number {
  const schedule = buildTargetSchedule(seed, durationMs);
  const session = new PulseDuelSession(schedule, durationMs);
  for (const hit of hits) session.applyHit(hit.targetId, hit.atMs);
  return session.snapshot().score;
}

void aliceName;
void bobName;
