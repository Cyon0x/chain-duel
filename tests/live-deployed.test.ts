/**
 * Deployed smoke + no-stake demo duel.
 *
 * Verifies a real deployment end to end without moving any funds, and asserts
 * that the computer opponent's configured win probability never appears in any
 * player-facing payload.
 *
 *   CHAIN_DUEL_DEPLOYED_URL=https://chain-duel.vercel.app npx vitest run tests/live-deployed.test.ts
 */
import { describe, expect, it } from "vitest";
import { buildTargetSchedule, scoreMatch } from "@/lib/game/pulse";
import type { HitRecord } from "@/lib/game/pulse";

const BASE = process.env.CHAIN_DUEL_DEPLOYED_URL ?? "";
const LIVE = BASE.startsWith("http");

async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; cookie?: string | null } = {},
): Promise<{ status: number; body: T; cookie: string | null; raw: string }> {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const raw = await response.text();
  let body: unknown = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw;
  }
  const setCookie = response.headers.getSetCookie?.() ?? [];
  return {
    status: response.status,
    body: body as T,
    raw,
    cookie: setCookie.length > 0 ? setCookie[0].split(";")[0] : null,
  };
}

describe.runIf(LIVE)("deployed Chain Duel", () => {
  it("serves the product and runs a full demo duel without staking", { timeout: 120_000 }, async () => {
    const suffix = Math.random().toString(36).slice(2, 7);

    const health = await api<{ network: string; integrations: { escrow: boolean } }>("/api/health");
    expect(health.status).toBe(200);
    expect(health.body.network).toBe("testnet");
    expect(health.body.integrations.escrow).toBe(true);

    // A serverless deployment without a database cannot keep accounts between
    // invocations. That must be disclosed rather than silently broken, and the
    // full duel flow is only meaningful once storage is durable.
    const persistence = (health.body as { persistence?: string }).persistence;
    if (persistence !== "postgres" && persistence !== "sqlite-file") {
      const page = await api("/");
      expect(page.status).toBe(200);
      expect(persistence).toBe("sqlite-memory");
      console.warn(
        `[live-deployed] Skipping the duel flow: this deployment reports persistence="${persistence}". ` +
          "Set DATABASE_URL to run the full deployed flow.",
      );
      return;
    }

    const signIn = await api("/api/auth/demo", { method: "POST", body: { name: `judge${suffix}` } });
    expect(signIn.status, signIn.raw).toBe(200);
    const cookie = signIn.cookie;
    expect(cookie).toBeTruthy();

    const onboard = await api("/api/onboarding", {
      method: "POST",
      cookie,
      body: { username: `judge${suffix}`, theme: "circuit" },
    });
    expect(onboard.status, onboard.raw).toBe(200);

    const before = await api<{ profile: { rating: number; games_played: number } }>("/api/profile", { cookie });
    expect(before.status).toBe(200);

    // The bot payload must never disclose the configured win probability.
    const bot = await api("/api/bot?entryStroops=50000000", { cookie });
    expect(bot.status, bot.raw).toBe(200);
    expect(bot.raw).not.toMatch(/win.?probability|0\.8\b/i);

    const created = await api<{ game: { id: string } }>("/api/duels", {
      method: "POST",
      cookie,
      body: { mode: "bot", entryXlm: 5, demo: true },
    });
    expect(created.status, created.raw).toBe(200);
    const gameId = created.body.game.id;

    const entry = await api<{ escrow: { mode: string } }>(`/api/duels/${gameId}/entry`, {
      method: "POST",
      cookie,
      body: { action: "commit", role: "creator" },
    });
    expect(entry.status, entry.raw).toBe(200);
    expect(entry.body.escrow.mode).toBe("offchain");

    const started = await api(`/api/matches/${gameId}/start`, { method: "POST", cookie });
    expect(started.status, started.raw).toBe(200);

    const view = await api<{ schedule: ReturnType<typeof buildTargetSchedule>; game: { seed: string } }>(
      `/api/matches/${gameId}`,
      { cookie },
    );
    expect(view.status, view.raw).toBe(200);
    expect(view.body.schedule.length).toBeGreaterThan(20);

    const hits: HitRecord[] = view.body.schedule
      .slice(0, 30)
      .map((target) => ({ targetId: target.id, atMs: target.spawnAtMs + 160 }));
    const clientScore = scoreMatch(view.body.game.seed, { hits, misses: [] }).score;

    const submitted = await api<{ settled: boolean }>(`/api/matches/${gameId}/submit`, {
      method: "POST",
      cookie,
      body: { seat: 1, hits, misses: [], clientScore },
    });
    expect(submitted.status, submitted.raw).toBe(200);
    expect(submitted.body.settled).toBe(true);

    const finalView = await api<{
      game: { status: string; demo: number; payout_stroops: number };
      players: Array<{ is_bot: number; hits: number; score: number }>;
    }>(`/api/matches/${gameId}`, { cookie });
    expect(finalView.body.game.status).toBe("settled");
    expect(finalView.body.game.demo).toBe(1);
    const opponent = finalView.body.players.find((player) => player.is_bot === 1);
    expect(opponent?.hits ?? 0).toBeGreaterThan(0);

    // A demo duel simulates the result but must never fabricate a chain
    // transaction: every ledger row for this game is marked demo and carries no
    // Stellar hash.
    const ledger = await api<{
      transactions: Array<{ game_id: string | null; demo: number; status: string; tx_hash: string | null }>;
    }>("/api/transactions", { cookie });
    const rows = ledger.body.transactions.filter((row) => row.game_id === gameId);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.demo).toBe(1);
      expect(row.tx_hash).toBeNull();
    }

    // A demo duel must not move the competitive rating.
    const after = await api<{ profile: { rating: number } }>("/api/profile", { cookie });
    expect(after.body.profile.rating).toBe(before.body.profile.rating);

    const leaderboard = await api<{ players: Array<{ username: string; rating: number }> }>("/api/leaderboard");
    expect(leaderboard.status).toBe(200);
    expect(leaderboard.raw).not.toMatch(/win.?probability/i);
  });
});
