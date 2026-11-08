import { beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  ECONOMY,
  STAKE_PRESETS_XLM,
  parseStakeXlm,
  splitPool,
  xlmToStroops,
} from "@/lib/config/game";
import { entryStroopsOrThrow } from "@/lib/api/stake";
import { createDuel } from "@/lib/services/duel";
import { completeOnboarding, signInWithWallet } from "@/lib/services/accounts";
import { joinQueue } from "@/lib/services/matchmaking";
import { TREASURY_LIMITS } from "@/lib/config/game";

let userId = "";

beforeAll(async () => {
  const keypair = Keypair.random();
  const session = await signInWithWallet(keypair.publicKey());
  const username = `stake${Math.floor(Math.random() * 900_000 + 100_000)}`;
  const result = await completeOnboarding(session.userId, { username, theme: "neon" });
  expect(result.ok).toBe(true);
  userId = session.userId;
});

describe("stake presets", () => {
  it("offers all eight suggested entries", () => {
    expect(STAKE_PRESETS_XLM).toEqual([50, 100, 200, 500, 1000, 2000, 5000, 10000]);
  });

  it("keeps the 10,000 XLM preset inside the configured bounds", () => {
    expect(ECONOMY.maxEntryStroops).toBeGreaterThanOrEqual(xlmToStroops(10000));
    expect(ECONOMY.minEntryStroops).toBe(xlmToStroops(25));
  });
});

describe("parseStakeXlm", () => {
  it("accepts every preset", () => {
    for (const preset of STAKE_PRESETS_XLM) {
      const parsed = parseStakeXlm(preset);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.stroops).toBe(xlmToStroops(preset));
    }
  });

  it("accepts a valid custom amount", () => {
    const parsed = parseStakeXlm("125.5");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.stroops).toBe(xlmToStroops(125.5));
  });

  it("accepts the minimum boundary (25 XLM)", () => {
    const parsed = parseStakeXlm(25);
    expect(parsed.ok).toBe(true);
  });

  it("accepts the maximum boundary (10,000 XLM)", () => {
    const parsed = parseStakeXlm(10000);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.stroops).toBe(ECONOMY.maxEntryStroops);
  });

  it("rejects empty, non-numeric, zero and negative amounts", () => {
    expect(parseStakeXlm("").ok).toBe(false);
    expect(parseStakeXlm("   ").ok).toBe(false);
    expect(parseStakeXlm("abc").ok).toBe(false);
    expect(parseStakeXlm("1.2.3").ok).toBe(false);
    expect(parseStakeXlm(0).ok).toBe(false);
    expect(parseStakeXlm(-5).ok).toBe(false);
  });

  it("rejects amounts below the minimum and above the maximum", () => {
    expect(parseStakeXlm(0.5).ok).toBe(false);
    expect(parseStakeXlm(10000.0000001).ok).toBe(false);
    expect(parseStakeXlm(10001).ok).toBe(false);
  });

  it("rejects more than 7 decimal places", () => {
    expect(parseStakeXlm("25.1234567").ok).toBe(true);
    expect(parseStakeXlm("25.12345678").ok).toBe(false);
  });

  it.each([true, false, [], [50], {}, "0x32", "5e1", "Infinity", NaN, Infinity, "24.9999999", "10000.00000001", "25.00000001"])("rejects coerced or rounded input %j", (input) => {
    expect(parseStakeXlm(input).ok).toBe(false);
  });

  it("does not let caller options relax the hard bounds", () => {
    expect(parseStakeXlm(24, { minStroops: 0 }).ok).toBe(false);
    expect(parseStakeXlm(10001, { maxStroops: xlmToStroops(20000) }).ok).toBe(false);
  });

  it("supports the same maximum in computer mode with a full pool payout", () => {
    expect(TREASURY_LIMITS.maxBotEntryStroops).toBe(ECONOMY.maxEntryStroops);
    expect(TREASURY_LIMITS.maxPayoutStroops).toBeGreaterThanOrEqual(2 * ECONOMY.maxEntryStroops);
    expect(TREASURY_LIMITS.dailyBotLiabilityStroops).toBeGreaterThanOrEqual(ECONOMY.maxEntryStroops);
  });

  it("allows zero only for demo duels", () => {
    expect(parseStakeXlm(0, { demo: true }).ok).toBe(true);
    expect(parseStakeXlm(0, { demo: false }).ok).toBe(false);
  });

  it("honours a tighter per-mode cap (computer duels)", () => {
    const cap = { maxStroops: xlmToStroops(25) };
    expect(parseStakeXlm(25, cap).ok).toBe(true);
    expect(parseStakeXlm(50, cap).ok).toBe(false);
  });
});

describe("entryStroopsOrThrow", () => {
  it("converts a valid entry to stroops", () => {
    expect(entryStroopsOrThrow(25)).toBe(xlmToStroops(25));
  });

  it("rejects an invalid entry with an invalid_entry code", () => {
    expect(() => entryStroopsOrThrow(10001)).toThrowError(/Maximum stake/i);
    try {
      entryStroopsOrThrow("nope");
      throw new Error("expected throw");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("invalid_entry");
    }
  });
});

describe("createDuel entry validation", () => {
  it.each([24.9999999, 10000.0000001, 0, -1])("rejects invalid entries %s in every mode and matchmaking", async (xlm) => {
    for (const mode of ["private", "pvp", "bot"] as const) {
      await expect(createDuel({ userId, mode, entryStroops: xlmToStroops(xlm), demo: false })).rejects.toMatchObject({ code: "invalid_entry" });
    }
    await expect(joinQueue({ userId, entryStroops: xlmToStroops(xlm), demo: false })).rejects.toMatchObject({ code: "invalid_entry" });
  });
  it("accepts the 10,000 XLM maximum for a staked duel (reaching the escrow check)", async () => {
    await expect(
      createDuel({ userId, mode: "private", entryStroops: xlmToStroops(10000), demo: false }),
    ).rejects.toMatchObject({ code: "escrow_unavailable" });
  });

  it("rejects an entry above the maximum", async () => {
    await expect(
      createDuel({ userId, mode: "private", entryStroops: xlmToStroops(10001), demo: false }),
    ).rejects.toMatchObject({ code: "invalid_entry" });
  });

  it("rejects a non-integer stroop amount", async () => {
    await expect(
      createDuel({ userId, mode: "private", entryStroops: 1.5, demo: false }),
    ).rejects.toMatchObject({ code: "invalid_entry" });
  });
});

describe("90/10 settlement split", () => {
  it("splits a 25 + 25 XLM pool into 45 / 5", () => {
    const { payout, fee } = splitPool(xlmToStroops(25) * 2, ECONOMY.feeBps);
    expect(payout).toBe(xlmToStroops(45));
    expect(fee).toBe(xlmToStroops(5));
  });

  it("splits a 10,000 + 10,000 XLM pool into 18,000 / 2,000", () => {
    const { payout, fee } = splitPool(xlmToStroops(10000) * 2, ECONOMY.feeBps);
    expect(payout).toBe(xlmToStroops(18000));
    expect(fee).toBe(xlmToStroops(2000));
  });

  it("splits a custom 125.5 + 125.5 XLM pool with exact integer stroops", () => {
    const pool = xlmToStroops(125.5) * 2;
    const { payout, fee } = splitPool(pool, ECONOMY.feeBps);
    expect(payout + fee).toBe(pool);
    expect(payout).toBe(xlmToStroops(225.9));
  });
});
