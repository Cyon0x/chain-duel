import { describe, expect, it } from "vitest";
import { jsonSafe, ok } from "@/lib/api/respond";

describe("JSON-safe API responses", () => {
  it("converts bigint stroop amounts instead of throwing", () => {
    const payload = jsonSafe({ accrued: 50_000_000n, nested: { pool: 4_950_000_000n } });
    expect(() => JSON.stringify(payload)).not.toThrow();
    expect(payload).toEqual({ accrued: "50000000", nested: { pool: "4950000000" } });
  });

  it("walks arrays, dates and nulls", () => {
    const date = new Date("2026-01-01T00:00:00.000Z");
    expect(jsonSafe({ rows: [{ amount: 1n }], at: date, nothing: null })).toEqual({
      rows: [{ amount: "1" }],
      at: "2026-01-01T00:00:00.000Z",
      nothing: null,
    });
  });

  it("serves a bigint-bearing payload as a 200 rather than a 500", async () => {
    const response = ok({ fees: 10_000_000n });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ fees: "10000000" });
  });
});
