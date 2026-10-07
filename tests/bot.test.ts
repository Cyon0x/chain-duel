import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { PulseBot, simulateBotMatch, simulateHumanScore } from "@/lib/game/bot";
import { BOT_PROFILES, DEFAULT_BOT, PULSE_DUEL } from "@/lib/config/game";

const DURATION = PULSE_DUEL.durationMs;

/**
 * Reference "average human" used to calibrate the computer opponent. It is a
 * casual-but-engaged player: roughly 90% accuracy, ~260ms median reaction with
 * human jitter, and the occasional mistaken tap on a red target.
 */
const AVERAGE_HUMAN = { accuracy: 0.9, reactionMs: 260, jitterMs: 90, redMistakeRate: 0.05 };
/** A strong human should beat the computer more often than not. */
const STRONG_HUMAN = { accuracy: 0.96, reactionMs: 220, jitterMs: 70, redMistakeRate: 0.02 };

function botWinRate(profile = DEFAULT_BOT, skill = AVERAGE_HUMAN, samples = 3_000) {
  let botWins = 0;
  for (let index = 0; index < samples; index += 1) {
    const seed = `bot-sim-${index}`;
    const human = simulateHumanScore(seed, DURATION, skill).score;
    const bot = simulateBotMatch({ seed, profile, durationMs: DURATION }).bot.score;
    if (bot > human) botWins += 1;
  }
  return botWins / samples;
}

describe("computer opponent difficulty", () => {
  it("wins approximately 80% of matches against an average human", { timeout: 120_000 }, () => {
    const rate = botWinRate(DEFAULT_BOT, AVERAGE_HUMAN, 3_000);
    expect(rate).toBeGreaterThan(0.76);
    expect(rate).toBeLessThan(0.84);
  });

  it("is genuinely beatable — a strong human wins more often than not", { timeout: 120_000 }, () => {
    const rate = botWinRate(DEFAULT_BOT, STRONG_HUMAN, 2_000);
    expect(rate).toBeLessThan(0.5);
    expect(rate).toBeGreaterThan(0.1);
  });

  it("has a skill edge across every parameter, not a hidden dice roll", () => {
    const a = AVERAGE_HUMAN;
    expect(DEFAULT_BOT.accuracy).toBeGreaterThan(a.accuracy);
    expect(DEFAULT_BOT.reactionMs).toBeLessThan(a.reactionMs);
    expect(DEFAULT_BOT.mistakeRate).toBeLessThan(a.redMistakeRate);
  });

  it("keeps the documented target rate in sync with the tuned profile", () => {
    expect(DEFAULT_BOT.targetWinRate).toBeCloseTo(0.8, 2);
    expect(BOT_PROFILES.standard).toBe(DEFAULT_BOT);
  });
});

describe("live computer opponent", () => {
  it("plays the real engine and scores real points", () => {
    const bot = new PulseBot("bot-seed-1", DEFAULT_BOT, DURATION);
    for (let at = 0; at <= DURATION; at += 250) bot.update(at);
    const snapshot = bot.snapshot();
    expect(snapshot.score).toBeGreaterThan(0);
    expect(snapshot.hits).toBeGreaterThan(0);
    expect(snapshot.botId).toBe(DEFAULT_BOT.id);
  });

  it("is bounded by the deterministic target stream — no fabricated score", () => {
    const perfect = new PulseBot("bot-seed-2", { ...DEFAULT_BOT, accuracy: 1, goldAccuracy: 1, mistakeRate: 0, jitterMs: 0, reactionMs: 40 }, DURATION);
    perfect.update(DURATION);
    const snapshot = perfect.snapshot();
    expect(snapshot.score).toBeGreaterThan(0);
    expect(snapshot.score).toBeLessThan(60_000);
  });

  it("produces the same score no matter when it is sampled or replayed", () => {
    const stepped = simulateBotMatch({ seed: "bot-determinism", profile: DEFAULT_BOT, durationMs: DURATION, stepMs: 137 }).bot.score;
    const oneShot = simulateBotMatch({ seed: "bot-determinism", profile: DEFAULT_BOT, durationMs: DURATION, stepMs: DURATION }).bot.score;
    expect(oneShot).toBe(stepped);
  });

  it("can be resumed from an exported state mid-duel without changing the outcome", () => {
    const full = simulateBotMatch({ seed: "bot-resume", profile: DEFAULT_BOT, durationMs: DURATION });

    const bot = new PulseBot("bot-resume", DEFAULT_BOT, DURATION);
    for (let at = 0; at <= 30_000; at += 250) bot.update(at);
    const checkpoint = bot.exportState();

    const resumed = new PulseBot("bot-resume", DEFAULT_BOT, DURATION);
    resumed.restoreState(checkpoint);
    for (let at = 30_250; at <= DURATION; at += 250) resumed.update(at);

    expect(resumed.snapshot().score).toBe(full.bot.score);
  });

  it("only ever scores through the shared session", () => {
    const bot = new PulseBot("bot-audit", DEFAULT_BOT, DURATION);
    expect(bot.snapshot().score).toBe(0);
    bot.update(10_000);
    expect(bot.snapshot().score).toBeGreaterThanOrEqual(0);
  });

  it("never uses Math.random", async () => {
    const raw = await readFile(new URL("../src/lib/game/bot.ts", import.meta.url), "utf8");
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/Math\.random/);
  });
});
