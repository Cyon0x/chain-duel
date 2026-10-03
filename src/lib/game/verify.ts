import { PULSE_DUEL, type PulseDuelConfig } from "../config/game";
import {
  MIN_REACTION_MS,
  PulseDuelSession,
  buildTargetSchedule,
  theoreticalMaxScore,
  type HitRecord,
  type MatchScore,
  type MissRecord,
} from "./pulse";

export interface SubmissionPayload {
  matchId: string;
  seat: number;
  hits: HitRecord[];
  misses: MissRecord[];
  clientScore: number;
  clientDurationMs?: number;
}

export interface VerificationResult {
  valid: boolean;
  score: MatchScore;
  errors: string[];
  warnings: string[];
}

const MAX_EVENTS = 4_000;
const TIMESTAMP_TOLERANCE_MS = 400;

/**
 * Authoritative replay of a submitted duel. The client never sends a score that
 * we trust — it sends its event log and we recompute the score from the shared
 * deterministic schedule. Impossible inputs are rejected outright.
 */
export function verifySubmission(
  payload: SubmissionPayload,
  options: { seed: string; durationMs?: number; config?: PulseDuelConfig; startedAtMs?: number },
): VerificationResult {
  const durationMs = options.durationMs ?? PULSE_DUEL.durationMs;
  const config = options.config ?? PULSE_DUEL;
  const errors: string[] = [];
  const warnings: string[] = [];

  const hits = Array.isArray(payload.hits) ? payload.hits : [];
  const misses = Array.isArray(payload.misses) ? payload.misses : [];

  if (hits.length + misses.length > MAX_EVENTS) {
    errors.push("event_log_too_large");
  }
  if (hits.length > 1_500) {
    errors.push("implausible_hit_count");
  }
  if (!Number.isInteger(payload.seat) || (payload.seat !== 1 && payload.seat !== 2)) {
    errors.push("invalid_seat");
  }
  if (!Number.isFinite(payload.clientScore)) {
    errors.push("invalid_client_score");
  }

  const allTimestamps = [...hits.map((hit) => hit.atMs), ...misses.map((miss) => miss.atMs)];
  for (const atMs of allTimestamps) {
    if (!Number.isFinite(atMs) || !Number.isInteger(atMs) || atMs < 0) {
      errors.push("invalid_event_timestamp");
      break;
    }
    if (atMs > durationMs + TIMESTAMP_TOLERANCE_MS) {
      errors.push("event_after_match_end");
      break;
    }
  }

  if (errors.length > 0) {
    return {
      valid: false,
      errors,
      warnings,
      score: {
        score: 0,
        hits: 0,
        misses: 0,
        wrongTargets: 0,
        maxCombo: 0,
        bestMultiplier: 1,
        accuracy: 0,
        rejected: 0,
        lastHitAtMs: -1,
      },
    };
  }

  const schedule = buildTargetSchedule(options.seed, durationMs, config);
  const targetById = new Map(schedule.map((target) => [target.id, target]));
  const seen = new Set<number>();
  for (const hit of hits) {
    const target = targetById.get(hit.targetId);
    if (!target) {
      errors.push("hit_unknown_target");
      break;
    }
    if (seen.has(hit.targetId)) {
      errors.push("duplicate_hit_target");
      break;
    }
    seen.add(hit.targetId);
    if (hit.atMs < target.spawnAtMs + MIN_REACTION_MS) {
      errors.push("hit_before_target_spawn");
      break;
    }
    if (hit.atMs > target.expiresAtMs) {
      errors.push("hit_after_target_expiry");
      break;
    }
  }

  const session = new PulseDuelSession(schedule, durationMs, config);
  const events = [
    ...hits.map((hit) => ({ kind: "hit" as const, targetId: hit.targetId, atMs: hit.atMs })),
    ...misses.map((miss) => ({ kind: "miss" as const, atMs: miss.atMs })),
  ].sort((a, b) => a.atMs - b.atMs);

  let previousAt = -1;
  for (const event of events) {
    if (event.atMs < previousAt) warnings.push("non_monotonic_events");
    previousAt = Math.max(previousAt, event.atMs);
    if (event.kind === "hit" && event.targetId !== undefined) {
      session.applyHit(event.targetId, event.atMs);
    } else {
      session.applyMiss(event.atMs);
    }
  }

  const score = session.snapshot();
  const ceiling = theoreticalMaxScore(schedule, config);
  if (score.score > ceiling) errors.push("score_above_theoretical_max");
  if (score.rejected > 0) errors.push("rejected_events_present");
  if (Math.abs(score.score - payload.clientScore) > 1) errors.push("client_score_mismatch");

  if (errors.length === 0) {
    const positive = schedule.filter((target) => target.points > 0).length;
    if (score.hits > positive) errors.push("more_hits_than_targets");
  }

  return { valid: errors.length === 0, score, errors, warnings };
}
