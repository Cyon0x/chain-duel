import { PULSE_DUEL, type BotProfile, type PulseDuelConfig } from "../config/game";
import { MIN_REACTION_MS, PulseDuelSession, buildTargetSchedule, type MatchScore, type TargetSpec } from "./pulse";
import type { SessionState } from "./pulse";
import { Rng } from "./rng";

interface BotPlanEntry {
  target: TargetSpec;
  attemptRoll: number;
  mistakeRoll: number;
  missRoll: number;
  reactionOffset: number;
  /** Pre-resolved skill for this target, so the outcome does not depend on when it is evaluated. */
  hitChance: number;
}

/** Shared "a failed attempt is a mistimed click that breaks the combo" chance. */
export const MISS_ON_FAIL_RATE = 0.25;

export interface BotSnapshot extends MatchScore {
  botId: string;
  name: string;
  difficulty: BotProfile["difficulty"];
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * A live computer opponent.
 *
 * The bot does not receive a fake score and it never has its result adjusted
 * after the fact. It is given the exact same deterministic target stream as the
 * human and plays it with its own skill profile: a per-target reaction time
 * (jittered around `reactionMs`), a hit probability (`accuracy`), extra focus
 * on high-value gold targets, combo protection, and a small chance of an
 * accidental red hit.
 *
 * Every point it scores is produced by the same `PulseDuelSession` the human
 * uses, and its final score is a pure function of `(seed, profile)` — so it is
 * identical whether it is sampled live for the HUD or replayed at settlement,
 * and it can always be beaten by a player who out-scores it.
 */
export class PulseBot {
  private readonly session: PulseDuelSession;
  private readonly plan: BotPlanEntry[];
  private cursor = 0;

  constructor(
    readonly seed: string,
    readonly profile: BotProfile,
    readonly durationMs: number = PULSE_DUEL.durationMs,
    readonly config: PulseDuelConfig = PULSE_DUEL,
  ) {
    const schedule = buildTargetSchedule(seed, durationMs, config);
    this.session = new PulseDuelSession(schedule, durationMs, config);
    const rng = new Rng(`bot:${profile.id}:${seed}`);
    this.plan = schedule.map((target) => {
      // A gold target is only worth chasing harder if it is genuinely strong.
      const baseSkill = target.points > 0 && target.kind === "gold" ? profile.goldAccuracy : profile.accuracy;
      return {
        target,
        attemptRoll: rng.float(),
        mistakeRoll: rng.float(),
        missRoll: rng.float(),
        // Never below the engine's human-reaction floor, or the hit is rejected as scripted.
        reactionOffset: Math.max(MIN_REACTION_MS, profile.reactionMs + rng.range(-profile.jitterMs, profile.jitterMs)),
        // Combo protection nudges the hit chance up while a streak is live.
        hitChance: clamp(
          baseSkill + profile.comboAwareness * (1 - baseSkill) * 0.2,
          0,
          0.995,
        ),
      };
    });
  }

  /** Whether the bot can physically reach a target in time. */
  private isReachable(entry: BotPlanEntry): boolean {
    const resolveAt = entry.target.spawnAtMs + entry.reactionOffset;
    return (
      resolveAt >= entry.target.spawnAtMs &&
      resolveAt <= entry.target.expiresAtMs &&
      resolveAt <= this.durationMs
    );
  }

  /** Advance the bot's play up to `atMs`. Independent of any player score. */
  update(atMs: number): void {
    while (this.cursor < this.plan.length) {
      const entry = this.plan[this.cursor];
      const resolveAt = entry.target.spawnAtMs + entry.reactionOffset;
      if (resolveAt > atMs) break;
      this.cursor += 1;

      if (entry.target.points < 0) {
        // Reds are deliberately avoided; only a genuine mistake takes the penalty.
        if (entry.mistakeRoll < this.profile.mistakeRate) {
          this.session.applyHit(entry.target.id, Math.min(resolveAt, entry.target.expiresAtMs));
        }
        continue;
      }

      // A target that expires before the bot can react is simply not clicked —
      // in Pulse Duel an unclicked target does not break the combo.
      if (!this.isReachable(entry)) continue;
      if (entry.attemptRoll < entry.hitChance) {
        this.session.applyHit(entry.target.id, resolveAt);
      } else if (entry.missRoll < MISS_ON_FAIL_RATE) {
        // A failed attempt is a mistimed click: it breaks the combo, exactly
        // like a human who swings at a target and misses.
        this.session.applyMiss(Math.min(resolveAt, this.durationMs));
      }
    }
  }

  snapshot(): BotSnapshot {
    return {
      ...this.session.snapshot(),
      botId: this.profile.id,
      name: this.profile.name,
      difficulty: this.profile.difficulty,
    };
  }

  exportState(): BotState {
    return { cursor: this.cursor, session: this.session.exportState() };
  }

  restoreState(state: BotState): void {
    this.cursor = state.cursor;
    this.session.restoreState(state.session);
  }
}

export interface BotState {
  cursor: number;
  session: SessionState;
}

/** Deterministic reference skill for a synthetic human, used in statistical tests. */
export function simulateHumanScore(
  seed: string,
  durationMs: number,
  skill: { accuracy: number; reactionMs: number; jitterMs: number; redMistakeRate?: number },
  config: PulseDuelConfig = PULSE_DUEL,
): MatchScore {
  const schedule = buildTargetSchedule(seed, durationMs, config);
  const session = new PulseDuelSession(schedule, durationMs, config);
  const rng = new Rng(`human:${seed}`);
  for (const target of schedule) {
    const resolveAt = target.spawnAtMs + Math.max(40, skill.reactionMs + rng.range(-skill.jitterMs, skill.jitterMs));
    if (resolveAt > durationMs) break;
    if (target.points < 0) {
      // Humans occasionally tap a red by mistake.
      if (rng.float() < (skill.redMistakeRate ?? 0.05)) {
        session.applyHit(target.id, Math.min(resolveAt, target.expiresAtMs));
      }
      continue;
    }
    if (rng.float() < skill.accuracy) {
      const result = session.applyHit(target.id, resolveAt);
      if (!result.accepted) session.applyMiss(Math.min(resolveAt, durationMs));
    } else if (rng.float() < MISS_ON_FAIL_RATE) {
      session.applyMiss(Math.min(resolveAt, durationMs));
    }
  }
  return session.snapshot();
}

/** Plays an entire bot match offline. Used by tests and by settlement validation. */
export function simulateBotMatch(input: {
  seed: string;
  profile: BotProfile;
  durationMs: number;
  stepMs?: number;
  config?: PulseDuelConfig;
}): { bot: MatchScore; timeline: number[] } {
  const step = input.stepMs ?? 250;
  const bot = new PulseBot(
    input.seed,
    input.profile,
    input.durationMs,
    input.config ?? PULSE_DUEL,
  );
  const timeline: number[] = [];
  for (let at = 0; at <= input.durationMs; at += step) {
    bot.update(at);
    timeline.push(bot.snapshot().score);
  }
  bot.update(input.durationMs);
  return { bot: bot.snapshot(), timeline };
}
