import { PULSE_DUEL, type BotProfile, type PulseDuelConfig } from "../config/game";
import { PulseDuelSession, buildTargetSchedule, type MatchScore, type TargetSpec } from "./pulse";
import type { SessionState } from "./pulse";
import { Rng, secureChance } from "./rng";

export type BotOutcome = "bot" | "player";

interface BotPlanEntry {
  target: TargetSpec;
  attemptRoll: number;
  mistakeRoll: number;
  reactionOffset: number;
}

export interface BotSnapshot extends MatchScore {
  botId: string;
  name: string;
  difficulty: BotProfile["difficulty"];
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * A live computer opponent.
 *
 * The bot does not receive a fake score. It receives the exact same
 * deterministic target stream as the human, decides which targets to chase with
 * a per-target plan (reaction time, accuracy, mistake roll), and every point it
 * scores is produced by the same `PulseDuelSession` the players use.
 *
 * `steering` nudges the bot's *skill parameters* towards the configured match
 * outcome during the second half of the duel. It never writes a score directly,
 * and if a human outperforms the bot's ceiling the bot simply loses.
 */
export class PulseBot {
  private readonly session: PulseDuelSession;
  private readonly plan: BotPlanEntry[];
  private readonly steeringFromMs: number;
  private readonly steeringFullMs: number;
  private cursor = 0;

  constructor(
    readonly seed: string,
    readonly profile: BotProfile,
    readonly outcome: BotOutcome,
    readonly durationMs: number = PULSE_DUEL.durationMs,
    readonly config: PulseDuelConfig = PULSE_DUEL,
  ) {
    const schedule = buildTargetSchedule(seed, durationMs, config);
    this.session = new PulseDuelSession(schedule, durationMs, config);
    const rng = new Rng(`bot:${profile.id}:${seed}`);
    this.plan = schedule.map((target) => ({
      target,
      attemptRoll: rng.float(),
      mistakeRoll: rng.float(),
      reactionOffset: Math.max(
        24,
        profile.reactionMs + rng.range(-profile.jitterMs, profile.jitterMs),
      ),
    }));
    this.steeringFromMs = durationMs * 0.45;
    this.steeringFullMs = durationMs * 0.72;
  }

  private skillMultiplier(atMs: number, playerScore: number): number {
    if (atMs < this.steeringFromMs) return 1;
    const ramp = clamp(
      (atMs - this.steeringFromMs) / (this.steeringFullMs - this.steeringFromMs),
      0,
      1,
    );

    const snapshot = this.session.snapshot();
    const botScore = snapshot.score;
    const lead = Math.max(6, Math.round(playerScore * 0.12) + 4);
    const desired = this.outcome === "bot" ? playerScore + lead : Math.max(0, playerScore - lead);
    const error = desired - botScore;
    const raw = clamp(error / 70, -0.55, 0.7);
    return clamp(1 + raw * ramp, 0.35, 2.2);
  }

  /** Advance the bot's play up to `atMs`, reacting to the human's live score. */
  update(atMs: number, playerScore: number): void {
    const multiplier = this.skillMultiplier(atMs, playerScore);

    while (this.cursor < this.plan.length) {
      const entry = this.plan[this.cursor];
      const resolveAt = entry.target.spawnAtMs + entry.reactionOffset;
      if (resolveAt > atMs) break;
      this.cursor += 1;

      if (entry.target.points < 0) {
        // Deliberately avoid red targets; mistakes happen at the profile's rate.
        if (entry.mistakeRoll < this.profile.mistakeRate * 0.5) {
          this.session.applyHit(entry.target.id, Math.min(resolveAt, entry.target.expiresAtMs));
        }
        continue;
      }

      const attemptProbability = clamp(entry.attemptRoll * multiplier, 0.1, 0.99);
      if (entry.attemptRoll > attemptProbability) continue;
      const result = this.session.applyHit(entry.target.id, resolveAt);
      if (!result.accepted) {
        // Chased a target it could not reach in time — a genuine miss.
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

/**
 * Settlement-side draw of the intended outcome. Uses the platform CSPRNG —
 * never Math.random() — and is the single place the configured probability is
 * consulted. It is never surfaced in any player-facing payload.
 */
export function drawBotOutcome(profile: BotProfile, rollForTesting?: number): BotOutcome {
  const roll = rollForTesting ?? (secureChance(profile.winProbability) ? 0 : 1);
  return roll === 0 ? "bot" : "player";
}

/** Deterministic reference skill for a synthetic human, used in statistical tests. */
export function simulateHumanScore(
  seed: string,
  durationMs: number,
  skill: { accuracy: number; reactionMs: number; jitterMs: number },
  config: PulseDuelConfig = PULSE_DUEL,
): MatchScore {
  const schedule = buildTargetSchedule(seed, durationMs, config);
  const session = new PulseDuelSession(schedule, durationMs, config);
  const rng = new Rng(`human:${seed}`);
  for (const target of schedule) {
    const resolveAt = target.spawnAtMs + Math.max(40, skill.reactionMs + rng.range(-skill.jitterMs, skill.jitterMs));
    if (resolveAt > durationMs) break;
    if (target.points < 0) continue;
    if (rng.float() < skill.accuracy) {
      const result = session.applyHit(target.id, resolveAt);
      if (!result.accepted) session.applyMiss(Math.min(resolveAt, durationMs));
    } else if (rng.float() < 0.25) {
      session.applyMiss(Math.min(resolveAt, durationMs));
    }
  }
  return session.snapshot();
}

/** Plays an entire bot match offline. Used by tests and by settlement validation. */
export function simulateBotMatch(input: {
  seed: string;
  profile: BotProfile;
  outcome: BotOutcome;
  durationMs: number;
  stepMs?: number;
  playerScoreAt: (atMs: number) => number;
  config?: PulseDuelConfig;
}): { bot: MatchScore; timeline: number[] } {
  const step = input.stepMs ?? 250;
  const bot = new PulseBot(
    input.seed,
    input.profile,
    input.outcome,
    input.durationMs,
    input.config ?? PULSE_DUEL,
  );
  const timeline: number[] = [];
  for (let at = 0; at <= input.durationMs; at += step) {
    bot.update(at, input.playerScoreAt(at));
    timeline.push(bot.snapshot().score);
  }
  bot.update(input.durationMs, input.playerScoreAt(input.durationMs));
  return { bot: bot.snapshot(), timeline };
}
