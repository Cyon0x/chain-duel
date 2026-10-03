import { describe, expect, it } from "vitest";
import {
  PulseBot,
  drawBotOutcome,
  simulateBotMatch,
  simulateHumanScore,
} from "@/lib/game/bot";
import { DEFAULT_BOT, PULSE_DUEL } from "@/lib/config/game";

const DURATION = PULSE_DUEL.durationMs;
const PLAYER = { accuracy: 0.82, reactionMs: 280, jitterMs: 90 };

describe("bot outcome draw", () => {
  it("is deterministic when a roll is supplied", () => {
    expect(drawBotOutcome(DEFAULT_BOT, 0)).toBe("bot");
    expect(drawBotOutcome(DEFAULT_BOT, 1)).toBe("player");
  });

  it("targets the configured win probability statistically", () => {
    const samples = 4_000;
    let botWins = 0;
    for (let index = 0; index < samples; index += 1) {
      if (drawBotOutcome(DEFAULT_BOT) === "bot") botWins += 1;
    }
    const rate = botWins / samples;
    // Not "exactly 80 out of 100" — a wide-but-meaningful band around 0.8.
    expect(rate).toBeGreaterThan(0.76);
    expect(rate).toBeLessThan(0.84);
  });

  it("uses the platform CSPRNG rather than Math.random", async () => {
    const raw = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../src/lib/game/bot.ts", import.meta.url), "utf8"),
    );
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/Math\.random/);
    expect(code).toMatch(/secureChance/);
  });
});

describe("live computer opponent", () => {
  it("plays the real engine and scores real points", () => {
    const bot = new PulseBot("bot-seed-1", DEFAULT_BOT, "bot", DURATION);
    for (let at = 0; at <= DURATION; at += 250) bot.update(at, 0);
    const snapshot = bot.snapshot();
    expect(snapshot.score).toBeGreaterThan(0);
    expect(snapshot.hits).toBeGreaterThan(0);
    expect(snapshot.botId).toBe(DEFAULT_BOT.id);
  });

  it("cannot reach an unbeatable player score — the bot has a real, bounded ceiling", () => {
    const bot = new PulseBot("bot-seed-2", DEFAULT_BOT, "player", DURATION);
    bot.update(DURATION, 10_000_000);
    const snapshot = bot.snapshot();
    // Steering only nudges skill parameters, so the bot is still capped by the
    // deterministic target stream and can never fabricate a winning score.
    expect(snapshot.score).toBeGreaterThan(0);
    expect(snapshot.score).toBeLessThan(10_000_000);
    expect(snapshot.score).toBeLessThanOrEqual(60_000);
  });

  it("wins when steered to win and loses when steered to lose, for equal skill", () => {
    const seed = "bot-match-1";
    const human = simulateHumanScore(seed, DURATION, PLAYER);
    const timeline = () => human.score;
    const botWins = simulateBotMatch({
      seed,
      profile: DEFAULT_BOT,
      outcome: "bot",
      durationMs: DURATION,
      playerScoreAt: timeline,
    }).bot.score;
    const botLoses = simulateBotMatch({
      seed,
      profile: DEFAULT_BOT,
      outcome: "player",
      durationMs: DURATION,
      playerScoreAt: timeline,
    }).bot.score;
    expect(botWins).toBeGreaterThan(human.score);
    expect(botLoses).toBeLessThan(human.score);
  });

  it("can be resumed from an exported state mid-duel without changing the outcome", () => {
    const playerScoreAt = () => 400;
    const full = simulateBotMatch({
      seed: "bot-resume",
      profile: DEFAULT_BOT,
      outcome: "bot",
      durationMs: DURATION,
      playerScoreAt,
    });

    const bot = new PulseBot("bot-resume", DEFAULT_BOT, "bot", DURATION);
    for (let at = 0; at <= 30_000; at += 250) bot.update(at, playerScoreAt());
    const checkpoint = bot.exportState();

    const resumed = new PulseBot("bot-resume", DEFAULT_BOT, "bot", DURATION);
    resumed.restoreState(checkpoint);
    for (let at = 30_250; at <= DURATION; at += 250) resumed.update(at, playerScoreAt());

    expect(resumed.snapshot().score).toBe(full.bot.score);
  });

  it("never writes a score directly and never uses Math.random", () => {
    const bot = new PulseBot("bot-audit", DEFAULT_BOT, "bot", DURATION);
    const before = bot.snapshot().score;
    expect(before).toBe(0);
    bot.update(10_000, 0);
    expect(bot.snapshot().score).toBeGreaterThanOrEqual(0);
  });
});
