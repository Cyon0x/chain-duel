import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
describe("network routing preserves legacy Stellar requests", () => {
  it("leaves original Stellar financial requests unchanged", async () => {
    const response = await proxy(
      new NextRequest("https://example.com/api/duels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entryStroops: 500_000_000 }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
  it("blocks Arc currency or network from entering Stellar services", async () => {
    for (const body of [{ networkId: "arc-mainnet", currency: "USDC" }, { currency: "USDC" }]) {
      const response = await proxy(
        new NextRequest("https://example.com/api/matchmaking", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(409);
    }
  });
  it("routes an explicitly selected Arc dashboard without switching wallets", async () => {
    const response = await proxy(
      new NextRequest("https://example.com/dashboard", { headers: { cookie: "cd_ecosystem=arc" } }),
    );
    expect(response.headers.get("location")).toBe("https://example.com/arc/dashboard");
  });
  it("does not route Stellar matches into Arc", async () => {
    const response = await proxy(
      new NextRequest("https://example.com/match/stellar-game", { headers: { cookie: "cd_ecosystem=arc" } }),
    );
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});
