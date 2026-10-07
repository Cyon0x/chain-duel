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
  it("offers 5 / 25 / 50 / 250 XLM", () => {
    expect(STAKE_PRESETS_XLM).toEqual([5, 25, 50, 250]);
  });

  it("keeps the 250 XLM preset inside the configured bounds", () => {
    expect(ECONOMY.maxEntryStroops).toBeGreaterThanOrEqual(xlmToStroops(250));
    expect(ECONOMY.minEntryStroops).toBe(xlmToStroops(1));
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
    const parsed = parseStakeXlm("12.5");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.stroops).toBe(xlmToStroops(12.5));
  });

  it("accepts the minimum boundary (1 XLM)", () => {
    const parsed = parseStakeXlm(1);
    expect(parsed.ok).toBe(true);
  });

  it("accepts the maximum boundary (250 XLM)", () => {
    const parsed = parseStakeXlm(250);
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
    expect(parseStakeXlm(250.0000001).ok).toBe(false);
    expect(parseStakeXlm(1000).ok).toBe(false);
  });

  it("rejects more than 7 decimal places", () => {
    expect(parseStakeXlm("1.1234567").ok).toBe(true);
    expect(parseStakeXlm("1.12345678").ok).toBe(false);
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
    expect(() => entryStroopsOrThrow(251)).toThrowError(/Maximum stake/i);
    try {
      entryStroopsOrThrow("nope");
      throw new Error("expected throw");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("invalid_entry");
    }
  });
});

describe("createDuel entry validation", () => {
  it("accepts the 250 XLM maximum for a staked duel (reaching the escrow check)", async () => {
    await expect(
      createDuel({ userId, mode: "private", entryStroops: xlmToStroops(250), demo: false }),
    ).rejects.toMatchObject({ code: "escrow_unavailable" });
  });

  it("rejects an entry above the maximum", async () => {
    await expect(
      createDuel({ userId, mode: "private", entryStroops: xlmToStroops(251), demo: false }),
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

  it("splits a 250 + 250 XLM pool into 450 / 50", () => {
    const { payout, fee } = splitPool(xlmToStroops(250) * 2, ECONOMY.feeBps);
    expect(payout).toBe(xlmToStroops(450));
    expect(fee).toBe(xlmToStroops(50));
  });

  it("splits a custom 12.5 + 12.5 XLM pool with exact integer stroops", () => {
    const pool = xlmToStroops(12.5) * 2;
    const { payout, fee } = splitPool(pool, ECONOMY.feeBps);
    expect(payout + fee).toBe(pool);
    expect(payout).toBe(xlmToStroops(22.5));
  });
});
