import { describe, expect, it } from "vitest";
import { applyElo, eloDelta, evaluateAchievements, expectedScore } from "@/lib/game/rating";
import { REPUTATION, RATING, splitPool, ECONOMY, TREASURY_LIMITS, xlmToStroops } from "@/lib/config/game";

describe("elo", () => {
  it("gives the favourite a smaller gain than the underdog", () => {
    expect(expectedScore(1200, 1000)).toBeGreaterThan(0.5);
    expect(eloDelta(1200, 1000, 1)).toBeLessThan(eloDelta(1000, 1200, 1));
  });

  it("is zero-sum for equal ratings", () => {
    const outcome = applyElo(1000, 1000, 1);
    expect(outcome.deltaA).toBe(16);
    expect(outcome.deltaB).toBe(-16);
    expect(outcome.ratingA).toBe(1016);
    expect(outcome.ratingB).toBe(984);
  });

  it("never drops a rating below the floor", () => {
    const outcome = applyElo(100, 2000, 0);
    expect(outcome.ratingA).toBeGreaterThanOrEqual(100);
  });

  it("uses the configured K-factor", () => {
    expect(RATING.kFactor).toBe(32);
    expect(eloDelta(1000, 1000, 1)).toBe(16);
  });
});

describe("achievements", () => {
  it("awards first duel and first win", () => {
    const unlocked = evaluateAchievements({
      gamesPlayed: 1,
      wins: 1,
      streak: 1,
      rating: 1000,
      maxCombo: 2,
      bestMultiplier: 1,
      score: 100,
      opponentLabel: "Bob",
      won: true,
    });
    expect(unlocked).toContain("first_duel");
    expect(unlocked).toContain("first_win");
  });

  it("unlocks the computer-breaker only against the computer", () => {
    const vsHuman = evaluateAchievements({
      gamesPlayed: 2, wins: 2, streak: 2, rating: 1010, maxCombo: 3, bestMultiplier: 1.2, score: 200,
      opponentLabel: "Bob", won: true,
    });
    const vsBot = evaluateAchievements({
      gamesPlayed: 2, wins: 2, streak: 2, rating: 1010, maxCombo: 3, bestMultiplier: 1.2, score: 200,
      opponentLabel: "VEX-7", won: true,
    });
    expect(vsHuman).not.toContain("beat_computer");
    expect(vsBot).toContain("beat_computer");
  });
});

describe("economy", () => {
  it("splits a 5+5 XLM pool into a 9 XLM reward and a 1 XLM fee", () => {
    const pool = xlmToStroops(10);
    const { fee, payout } = splitPool(pool, ECONOMY.feeBps);
    expect(fee).toBe(xlmToStroops(1));
    expect(payout).toBe(xlmToStroops(9));
    expect(fee + payout).toBe(pool);
  });

  it("keeps the default entry inside the treasury limits", () => {
    expect(ECONOMY.defaultEntryStroops).toBeLessThanOrEqual(TREASURY_LIMITS.maxBotEntryStroops);
    expect(TREASURY_LIMITS.minTreasuryBalanceStroops).toBeGreaterThan(0);
  });

  it("never produces a payout larger than the pool", () => {
    for (const bps of [0, 500, 1000, 2500, 3000]) {
      const pool = xlmToStroops(10);
      const { fee, payout } = splitPool(pool, bps);
      expect(fee + payout).toBe(pool);
      expect(fee).toBeGreaterThanOrEqual(0);
    }
  });

  it("keeps reputation bounded", () => {
    expect(REPUTATION.starting).toBeLessThanOrEqual(REPUTATION.max);
    expect(REPUTATION.abandonment).toBeLessThan(0);
  });
});
