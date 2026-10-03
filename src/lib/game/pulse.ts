import { PULSE_DUEL, comboMultiplier, type PulseDuelConfig, type TargetKindConfig } from "../config/game";
import { Rng } from "./rng";

export type TargetKind = "blue" | "gold" | "red";

export interface TargetSpec {
  id: number;
  kind: TargetKind;
  /** Normalised arena coordinates (0..1) so every viewport renders identically. */
  x: number;
  y: number;
  radius: number;
  points: number;
  spawnAtMs: number;
  expiresAtMs: number;
}

/** Minimum humanly plausible reaction time; blocks scripted instant hits. */
export const MIN_REACTION_MS = 70;

export function buildTargetSchedule(
  seed: string,
  durationMs: number = PULSE_DUEL.durationMs,
  config: PulseDuelConfig = PULSE_DUEL,
): TargetSpec[] {
  const rng = new Rng(`schedule:${seed}`);
  const targets: TargetSpec[] = [];
  const weights = config.targets.map((target) => target.weight);
  let id = 1;
  let at = 320;

  while (at < durationMs - 200) {
    const kindConfig: TargetKindConfig = config.targets[rng.weightedIndex(weights)];
    const radius = 0.052 * kindConfig.radiusFactor * rng.range(0.92, 1.08);
    const margin = radius + 0.01;
    const x = rng.range(margin, 1 - margin);
    const y = rng.range(margin, 1 - margin);
    const lifetime = kindConfig.lifetimeMs;

    targets.push({
      id,
      kind: kindConfig.kind,
      x,
      y,
      radius,
      points: kindConfig.points,
      spawnAtMs: Math.round(at),
      expiresAtMs: Math.round(at + lifetime),
    });

    id += 1;
    const density = targets.filter((target) => target.expiresAtMs > at).length;
    const pressure = density >= config.maxTargetsOnScreen ? 1.9 : 1;
    at += config.spawnIntervalMs * pressure * rng.range(0.78, 1.24);
  }

  return targets;
}

export interface HitRecord {
  targetId: number;
  atMs: number;
}

export interface MissRecord {
  atMs: number;
}

export interface MatchInput {
  hits: HitRecord[];
  misses: MissRecord[];
}

export interface MatchScore {
  score: number;
  hits: number;
  misses: number;
  wrongTargets: number;
  maxCombo: number;
  bestMultiplier: number;
  accuracy: number;
  rejected: number;
  lastHitAtMs: number;
}

export interface SessionState {
  score: number;
  hits: number;
  misses: number;
  wrongTargets: number;
  combo: number;
  maxCombo: number;
  bestMultiplier: number;
  rejected: number;
  lastHitAtMs: number;
  lastPositiveHitAtMs: number;
  hitIds: number[];
}

/**
 * Incremental, deterministic Pulse Duel session. The client drives one of these
 * for the HUD; the server replays submitted events through an identical one to
 * produce the authoritative score. Same code, same seed, same result.
 */
export class PulseDuelSession {
  private readonly hitIds = new Set<number>();
  private readonly targetById = new Map<number, TargetSpec>();
  private score = 0;
  private hits = 0;
  private misses = 0;
  private wrongTargets = 0;
  private combo = 0;
  private maxCombo = 0;
  private bestMultiplier = 1;
  private rejected = 0;
  private lastHitAtMs = -1;
  private lastPositiveHitAtMs = -Infinity;

  constructor(
    readonly schedule: TargetSpec[],
    readonly durationMs: number = PULSE_DUEL.durationMs,
    readonly config: PulseDuelConfig = PULSE_DUEL,
  ) {
    for (const target of schedule) this.targetById.set(target.id, target);
  }

  /** Targets visible at a point in time (used by the renderer and the bot). */
  visibleAt(atMs: number): TargetSpec[] {
    return this.schedule.filter(
      (target) =>
        target.spawnAtMs <= atMs && target.expiresAtMs > atMs && !this.hitIds.has(target.id),
    );
  }

  targetsSpawnedBetween(fromMs: number, toMs: number): TargetSpec[] {
    return this.schedule.filter(
      (target) => target.spawnAtMs > fromMs && target.spawnAtMs <= toMs,
    );
  }

  private multiplierFor(combo: number): number {
    return comboMultiplier(combo, this.config);
  }

  applyHit(targetId: number, atMs: number): { accepted: boolean; points: number; reason?: string } {
    const target = this.targetById.get(targetId);
    if (!target) {
      this.rejected += 1;
      return { accepted: false, points: 0, reason: "unknown_target" };
    }
    if (this.hitIds.has(targetId)) {
      this.rejected += 1;
      return { accepted: false, points: 0, reason: "duplicate_hit" };
    }
    if (atMs < target.spawnAtMs + MIN_REACTION_MS) {
      this.rejected += 1;
      return { accepted: false, points: 0, reason: "too_fast" };
    }
    if (atMs > target.expiresAtMs) {
      this.rejected += 1;
      return { accepted: false, points: 0, reason: "expired" };
    }
    if (atMs > this.durationMs) {
      this.rejected += 1;
      return { accepted: false, points: 0, reason: "after_match" };
    }

    this.hitIds.add(targetId);
    this.lastHitAtMs = atMs;

    if (target.points > 0) {
      this.combo = atMs - this.lastPositiveHitAtMs > this.config.comboWindowMs ? 1 : this.combo + 1;
      this.lastPositiveHitAtMs = atMs;
      const multiplier = this.multiplierFor(this.combo);
      this.bestMultiplier = Math.max(this.bestMultiplier, multiplier);
      const points = Math.round(target.points * multiplier);
      this.score = Math.max(0, this.score + points);
      this.hits += 1;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      return { accepted: true, points };
    }

    this.wrongTargets += 1;
    this.combo = 0;
    this.score = Math.max(0, this.score + target.points);
    return { accepted: true, points: target.points };
  }

  applyMiss(atMs: number): { accepted: boolean } {
    if (atMs > this.durationMs) {
      this.rejected += 1;
      return { accepted: false };
    }
    this.misses += 1;
    this.combo = 0;
    return { accepted: true };
  }

  get comboCount(): number {
    return this.combo;
  }

  /** Serializable state so a bot session can be resumed across requests. */
  exportState(): SessionState {
    return {
      score: this.score,
      hits: this.hits,
      misses: this.misses,
      wrongTargets: this.wrongTargets,
      combo: this.combo,
      maxCombo: this.maxCombo,
      bestMultiplier: this.bestMultiplier,
      rejected: this.rejected,
      lastHitAtMs: this.lastHitAtMs,
      lastPositiveHitAtMs: Number.isFinite(this.lastPositiveHitAtMs) ? this.lastPositiveHitAtMs : -1,
      hitIds: [...this.hitIds],
    };
  }

  restoreState(state: SessionState): void {
    this.score = state.score;
    this.hits = state.hits;
    this.misses = state.misses;
    this.wrongTargets = state.wrongTargets;
    this.combo = state.combo;
    this.maxCombo = state.maxCombo;
    this.bestMultiplier = state.bestMultiplier;
    this.rejected = state.rejected;
    this.lastHitAtMs = state.lastHitAtMs;
    this.lastPositiveHitAtMs = state.lastPositiveHitAtMs;
    this.hitIds.clear();
    for (const id of state.hitIds) this.hitIds.add(id);
  }

  get multiplier(): number {
    return this.multiplierFor(this.combo);
  }

  snapshot(): MatchScore {
    const attempts = this.hits + this.wrongTargets + this.misses;
    return {
      score: this.score,
      hits: this.hits,
      misses: this.misses,
      wrongTargets: this.wrongTargets,
      maxCombo: this.maxCombo,
      bestMultiplier: this.bestMultiplier,
      accuracy: attempts === 0 ? 0 : this.hits / attempts,
      rejected: this.rejected,
      lastHitAtMs: this.lastHitAtMs,
    };
  }
}

export function scoreMatch(
  seed: string,
  input: MatchInput,
  options: { durationMs?: number; config?: PulseDuelConfig } = {},
): MatchScore {
  const durationMs = options.durationMs ?? PULSE_DUEL.durationMs;
  const config = options.config ?? PULSE_DUEL;
  const schedule = buildTargetSchedule(seed, durationMs, config);
  const session = new PulseDuelSession(schedule, durationMs, config);
  const events: Array<{ kind: "hit" | "miss"; targetId?: number; atMs: number }> = [
    ...input.hits.map((hit) => ({ kind: "hit" as const, targetId: hit.targetId, atMs: hit.atMs })),
    ...input.misses.map((miss) => ({ kind: "miss" as const, atMs: miss.atMs })),
  ].sort((a, b) => a.atMs - b.atMs);

  for (const event of events) {
    if (event.kind === "hit" && event.targetId !== undefined) {
      session.applyHit(event.targetId, event.atMs);
    } else {
      session.applyMiss(event.atMs);
    }
  }
  return session.snapshot();
}

/** Maximum score technically reachable for a schedule — used to reject impossible claims. */
export function theoreticalMaxScore(schedule: TargetSpec[], config: PulseDuelConfig = PULSE_DUEL): number {
  const positive = schedule.filter((target) => target.points > 0);
  let score = 0;
  positive.forEach((target, index) => {
    score += Math.round(target.points * comboMultiplier(index + 1, config));
  });
  return score;
}
