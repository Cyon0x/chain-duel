import { describe, expect, it } from "vitest";
import {
  MIN_REACTION_MS,
  PulseDuelSession,
  buildTargetSchedule,
  scoreMatch,
  theoreticalMaxScore,
  type HitRecord,
} from "@/lib/game/pulse";
import { verifySubmission } from "@/lib/game/verify";
import { comboMultiplier, PULSE_DUEL } from "@/lib/config/game";
import { Rng } from "@/lib/game/rng";

const SEED = "test-seed-0001";
const DURATION = PULSE_DUEL.durationMs;

function perfectHits(seed = SEED, reactionMs = 150) {
  const schedule = buildTargetSchedule(seed, DURATION);
  const hits: HitRecord[] = schedule
    .filter((target) => target.points > 0)
    .map((target) => ({ targetId: target.id, atMs: target.spawnAtMs + reactionMs }));
  return { schedule, hits };
}

describe("target schedule", () => {
  it("is deterministic for a given seed", () => {
    const a = buildTargetSchedule(SEED, DURATION);
    const b = buildTargetSchedule(SEED, DURATION);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(20);
  });

  it("produces a different stream for a different seed", () => {
    const a = buildTargetSchedule(SEED, DURATION);
    const b = buildTargetSchedule("another-seed", DURATION);
    expect(a).not.toEqual(b);
  });

  it("keeps every target inside the arena and inside the match window", () => {
    for (const target of buildTargetSchedule(SEED, DURATION)) {
      expect(target.x).toBeGreaterThanOrEqual(0);
      expect(target.x).toBeLessThanOrEqual(1);
      expect(target.y).toBeGreaterThanOrEqual(0);
      expect(target.y).toBeLessThanOrEqual(1);
      expect(target.spawnAtMs).toBeGreaterThanOrEqual(0);
      expect(target.expiresAtMs).toBeLessThanOrEqual(DURATION + 5_000);
    }
  });
});

describe("scoring", () => {
  it("applies combo multipliers exactly at the configured tiers", () => {
    expect(comboMultiplier(1)).toBe(1);
    expect(comboMultiplier(3)).toBe(1.2);
    expect(comboMultiplier(5)).toBe(1.5);
    expect(comboMultiplier(8)).toBe(2);
    expect(comboMultiplier(40)).toBe(2);
  });

  it("never lets a score go negative", () => {
    const schedule = buildTargetSchedule(SEED, DURATION);
    const session = new PulseDuelSession(schedule, DURATION);
    const reds = schedule.filter((target) => target.kind === "red").slice(0, 5);
    for (const red of reds) {
      session.applyHit(red.id, red.spawnAtMs + MIN_REACTION_MS + 20);
    }
    expect(session.snapshot().score).toBe(0);
  });

  it("breaks the combo on a miss", () => {
    const schedule = buildTargetSchedule(SEED, DURATION);
    const session = new PulseDuelSession(schedule, DURATION);
    const blues = schedule.filter((target) => target.kind === "blue").slice(0, 4);
    for (const blue of blues) session.applyHit(blue.id, blue.spawnAtMs + 200);
    expect(session.comboCount).toBeGreaterThan(1);
    session.applyMiss(blues[3].spawnAtMs + 400);
    expect(session.comboCount).toBe(0);
  });

  it("reproduces the same score through the incremental session and the batch scorer", () => {
    const { hits } = perfectHits();
    const session = scoreMatch(SEED, { hits, misses: [] });
    const incremental = new PulseDuelSession(buildTargetSchedule(SEED, DURATION), DURATION);
    for (const hit of hits) incremental.applyHit(hit.targetId, hit.atMs);
    expect(incremental.snapshot().score).toBe(session.score);
  });

  it("keeps exportState/restoreState lossless (bot resumption)", () => {
    const { hits } = perfectHits();
    const session = new PulseDuelSession(buildTargetSchedule(SEED, DURATION), DURATION);
    for (const hit of hits.slice(0, 10)) session.applyHit(hit.targetId, hit.atMs);
    const state = session.exportState();
    const restored = new PulseDuelSession(buildTargetSchedule(SEED, DURATION), DURATION);
    restored.restoreState(state);
    expect(restored.snapshot()).toEqual(session.snapshot());
    expect(restored.comboCount).toBe(session.comboCount);
  });

  it("computes a theoretical ceiling above what any honest session can score", () => {
    const schedule = buildTargetSchedule(SEED, DURATION);
    const ceiling = theoreticalMaxScore(schedule);
    const { hits } = perfectHits();
    expect(scoreMatch(SEED, { hits, misses: [] }).score).toBeLessThanOrEqual(ceiling);
  });
});

describe("submission verification", () => {
  const base = () => {
    const { hits } = perfectHits();
    const score = scoreMatch(SEED, { hits, misses: [] }).score;
    return { hits, clientScore: score };
  };

  it("accepts an honest event log and recomputes the score", () => {
    const { hits, clientScore } = base();
    const result = verifySubmission(
      { matchId: "g1", seat: 1, hits, misses: [], clientScore },
      { seed: SEED, durationMs: DURATION },
    );
    expect(result.valid).toBe(true);
    expect(result.score.score).toBe(clientScore);
  });

  it("rejects a client-invented score", () => {
    const { hits } = base();
    const result = verifySubmission(
      { matchId: "g1", seat: 1, hits, misses: [], clientScore: 999_999 },
      { seed: SEED, durationMs: DURATION },
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("client_score_mismatch");
  });

  it("rejects hits on targets that do not exist", () => {
    const { hits } = base();
    const result = verifySubmission(
      { matchId: "g1", seat: 1, hits: [...hits, { targetId: 999_999, atMs: 1_000 }], misses: [], clientScore: 0 },
      { seed: SEED, durationMs: DURATION },
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("hit_unknown_target");
  });

  it("rejects duplicate hits on the same target", () => {
    const { hits } = base();
    const duplicate = hits[0];
    const result = verifySubmission(
      { matchId: "g1", seat: 1, hits: [...hits, { ...duplicate, atMs: duplicate.atMs + 10 }], misses: [], clientScore: 0 },
      { seed: SEED, durationMs: DURATION },
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("duplicate_hit_target");
  });

  it("rejects inhuman reaction times", () => {
    const schedule = buildTargetSchedule(SEED, DURATION);
    const target = schedule.find((entry) => entry.points > 0)!;
    const result = verifySubmission(
      {
        matchId: "g1",
        seat: 1,
        hits: [{ targetId: target.id, atMs: target.spawnAtMs + 5 }],
        misses: [],
        clientScore: 0,
      },
      { seed: SEED, durationMs: DURATION },
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("hit_before_target_spawn");
  });

  it("rejects hits after a target expired", () => {
    const schedule = buildTargetSchedule(SEED, DURATION);
    const target = schedule.find((entry) => entry.points > 0)!;
    const result = verifySubmission(
      {
        matchId: "g1",
        seat: 1,
        hits: [{ targetId: target.id, atMs: target.expiresAtMs + 50 }],
        misses: [],
        clientScore: 0,
      },
      { seed: SEED, durationMs: DURATION },
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("hit_after_target_expiry");
  });

  it("rejects events after the match ended", () => {
    const result = verifySubmission(
      { matchId: "g1", seat: 1, hits: [], misses: [{ atMs: DURATION + 5_000 }], clientScore: 0 },
      { seed: SEED, durationMs: DURATION },
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("event_after_match_end");
  });

  it("rejects an absurd event volume", () => {
    const hits = Array.from({ length: 2_000 }, (_, index) => ({ targetId: index + 1, atMs: 1_000 + index }));
    const result = verifySubmission(
      { matchId: "g1", seat: 1, hits, misses: [], clientScore: 0 },
      { seed: SEED, durationMs: DURATION },
    );
    expect(result.valid).toBe(false);
  });

  it("never awards more hits than there are positive targets", () => {
    const schedule = buildTargetSchedule(SEED, DURATION);
    const positives = schedule.filter((target) => target.points > 0);
    const hits = positives.map((target) => ({ targetId: target.id, atMs: target.spawnAtMs + MIN_REACTION_MS + 5 }));
    const result = verifySubmission(
      { matchId: "g1", seat: 1, hits, misses: [], clientScore: scoreMatch(SEED, { hits, misses: [] }).score },
      { seed: SEED, durationMs: DURATION },
    );
    expect(result.valid).toBe(true);
    expect(result.score.hits).toBeLessThanOrEqual(positives.length);
  });
});

describe("gameplay randomness stays deterministic", () => {
  it("Rng is stable for a given seed", () => {
    const a = new Rng("seed-a");
    const b = new Rng("seed-a");
    const c = new Rng("seed-b");
    expect([a.float(), a.float(), a.float()]).toEqual([b.float(), b.float(), b.float()]);
    expect(new Rng("seed-a").float()).not.toBe(c.float());
  });
});
