import { describe, expect, it } from "vitest";
import { arenaInvitePath, arenaInviteUrl } from "@/lib/arena";

describe("arena invite link", () => {
  it("points at the playable arena path", () => {
    expect(arenaInvitePath("ABC123")).toBe("/duel/ABC123");
  });

  it("builds the exact absolute URL the QR code encodes", () => {
    expect(arenaInviteUrl("https://chain-duel.vercel.app", "ABC123")).toBe(
      "https://chain-duel.vercel.app/duel/ABC123",
    );
  });

  it("trims a trailing origin slash so link and QR stay identical", () => {
    expect(arenaInviteUrl("https://chain-duel.vercel.app/", "ABC123")).toBe(
      arenaInviteUrl("https://chain-duel.vercel.app", "ABC123"),
    );
  });

  it("carries only the public arena path — no tokens or secrets", () => {
    const url = arenaInviteUrl("http://localhost:4310", "XYZ789");
    expect(url).toBe("http://localhost:4310/duel/XYZ789");
    expect(url).not.toMatch(/[?#]|token|secret|key/i);
  });
});
