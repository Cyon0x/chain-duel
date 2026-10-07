/** Chain Duel gameplay + economy configuration (server-authoritative defaults). */

export const STROOPS_PER_XLM = 10_000_000;

export function xlmToStroops(xlm: number): number {
  return Math.round(xlm * STROOPS_PER_XLM);
}

export function stroopsToXlm(stroops: number): number {
  return stroops / STROOPS_PER_XLM;
}

export function formatXlm(stroops: number, maxFractionDigits = 2): string {
  const value = stroopsToXlm(stroops);
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxFractionDigits,
  });
}

export interface TargetKindConfig {
  kind: "blue" | "gold" | "red";
  points: number;
  weight: number;
  lifetimeMs: number;
  radiusFactor: number;
}

export interface ComboTier {
  hits: number;
  multiplier: number;
}

export interface PulseDuelConfig {
  durationMs: number;
  countdownMs: number;
  maxTargetsOnScreen: number;
  spawnIntervalMs: number;
  targets: TargetKindConfig[];
  combos: ComboTier[];
  comboWindowMs: number;
  missedHitPenalty: number;
}

/**
 * Global gameplay pace. `1.25` makes every timed beat (target spawn cadence,
 * target lifetime and the combo window) 25% faster while leaving the match
 * length, target mix, point values and combo tiers untouched.
 */
export const PULSE_SPEED_MULTIPLIER = 1.25;

/** Scales a base millisecond value by the pace multiplier (faster = smaller). */
function paced(ms: number): number {
  return Math.round(ms / PULSE_SPEED_MULTIPLIER);
}

export const PULSE_DUEL: PulseDuelConfig = {
  durationMs: 60_000,
  countdownMs: 3_200,
  maxTargetsOnScreen: 4,
  spawnIntervalMs: paced(620),
  comboWindowMs: paced(2_200),
  missedHitPenalty: 0,
  targets: [
    { kind: "blue", points: 10, weight: 62, lifetimeMs: paced(1_500), radiusFactor: 1 },
    { kind: "gold", points: 25, weight: 18, lifetimeMs: paced(1_150), radiusFactor: 0.82 },
    { kind: "red", points: -15, weight: 20, lifetimeMs: paced(1_700), radiusFactor: 1.08 },
  ],
  combos: [
    { hits: 3, multiplier: 1.2 },
    { hits: 5, multiplier: 1.5 },
    { hits: 8, multiplier: 2 },
  ],
};

export function comboMultiplier(hits: number, config: PulseDuelConfig = PULSE_DUEL): number {
  let multiplier = 1;
  for (const tier of config.combos) {
    if (hits >= tier.hits) multiplier = tier.multiplier;
  }
  return multiplier;
}

export interface EconomyConfig {
  defaultEntryStroops: number;
  minEntryStroops: number;
  maxEntryStroops: number;
  feeBps: number;
  demoEntryStroops: number;
}

export const ECONOMY: EconomyConfig = {
  defaultEntryStroops: xlmToStroops(5),
  minEntryStroops: xlmToStroops(1),
  maxEntryStroops: xlmToStroops(100),
  feeBps: 1000,
  demoEntryStroops: 0,
};

export interface TreasuryLimits {
  minTreasuryBalanceStroops: number;
  maxBotEntryStroops: number;
  maxPayoutStroops: number;
  dailyBotLiabilityStroops: number;
}

export const TREASURY_LIMITS: TreasuryLimits = {
  minTreasuryBalanceStroops: xlmToStroops(100),
  maxBotEntryStroops: xlmToStroops(25),
  maxPayoutStroops: xlmToStroops(250),
  dailyBotLiabilityStroops: xlmToStroops(1000),
};

export interface BotProfile {
  id: string;
  name: string;
  difficulty: "rookie" | "standard" | "veteran";
  /** Median reaction time to a freshly spawned target. */
  reactionMs: number;
  /** Per-target hit probability for a reachable blue target. */
  accuracy: number;
  /** Higher-value gold targets are chased a little harder. */
  goldAccuracy: number;
  /** Probability of accidentally tapping a red (penalty) target. */
  mistakeRate: number;
  /** 0..1 — how strongly a live combo is protected with extra focus. */
  comboAwareness: number;
  /** Reaction-time spread, so the bot is strong but not robotic. */
  jitterMs: number;
  /**
   * Documented empirical win rate against the reference average human.
   * This is a *target that the skill parameters are tuned to produce*, not a
   * coin flip: the bot never has its score or outcome altered, and it can
   * always be beaten by a strong player. Verified by tests/bot.test.ts.
   */
  targetWinRate: number;
}

/**
 * The computer opponent is a real player in the duel: it runs the same engine,
 * reacts to the same deterministic target stream, and its outcome is honoured
 * by settlement.
 */
export const BOT_PROFILES: Record<string, BotProfile> = {
  standard: {
    id: "cd-computer-01",
    name: "VEX-7",
    difficulty: "standard",
    reactionMs: 200,
    accuracy: 0.915,
    goldAccuracy: 0.935,
    mistakeRate: 0.015,
    comboAwareness: 0.7,
    jitterMs: 40,
    targetWinRate: 0.8,
  },
};

export const DEFAULT_BOT = BOT_PROFILES.standard;

export function splitPool(poolStroops: number, feeBps: number) {
  const fee = Math.floor((poolStroops * feeBps) / 10_000);
  return { fee, payout: poolStroops - fee };
}

export const RATING = {
  starting: 1000,
  kFactor: 32,
  botRatingDelta: 0,
};

export const REPUTATION = {
  starting: 100,
  min: 0,
  max: 100,
  completedMatch: 2,
  disconnect: -6,
  cancel: -1,
  abandonment: -10,
};

export const INVITE_TTL_MS = 30 * 60 * 1000;
export const DUEL_JOIN_WINDOW_MS = 15 * 60 * 1000;
export const QUEUE_TTL_MS = 90 * 1000;

export function inviteCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < 6; i += 1) code += alphabet[bytes[i] % alphabet.length];
  return code;
}
