import { describe, expect, it } from "vitest";
import { isResultFinal, resolveOutcome } from "@/lib/game/outcome";

const SELF = "user-self";
const OTHER = "user-other";

const base = { status: "settled", settlement_status: "confirmed", winner_id: null, mode: "pvp" } as const;

describe("result resolution", () => {
  it("treats an in-flight settlement as pending, never as a draw", () => {
    const inFlight = { ...base, status: "finished", settlement_status: "submitting" };
    expect(isResultFinal(inFlight)).toBe(false);
    expect(resolveOutcome(inFlight, SELF)).toBe("pending");
    expect(resolveOutcome({ ...inFlight, status: "active", settlement_status: null }, SELF)).toBe("pending");
  });

  it("reports win/loss from the recorded winner", () => {
    expect(resolveOutcome({ ...base, winner_id: SELF }, SELF)).toBe("win");
    expect(resolveOutcome({ ...base, winner_id: OTHER }, SELF)).toBe("loss");
    expect(resolveOutcome({ ...base, winner_id: OTHER }, OTHER)).toBe("win");
  });

  it("distinguishes a computer win from a genuine draw", () => {
    expect(resolveOutcome({ ...base, mode: "bot", winner_id: null }, SELF)).toBe("loss");
    expect(resolveOutcome({ ...base, mode: "pvp", winner_id: null }, SELF)).toBe("draw");
  });

  it("only ever reports a final outcome once settlement is confirmed", () => {
    const confirmedFinished = { ...base, status: "finished", settlement_status: "confirmed" };
    expect(isResultFinal(confirmedFinished)).toBe(true);
    expect(resolveOutcome(confirmedFinished, SELF)).toBe("draw");
  });
});
