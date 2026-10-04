/**
 * Deployed "play again" regression: after a matchmaking duel settles, the queue
 * ticket must be released so the next search starts a genuinely new match
 * instead of looping the player back to the finished duel's result screen.
 *
 * No funds move — it runs a demo duel against the deployed app.
 *
 *   CHAIN_DUEL_DEPLOYED_URL=https://chain-duel.vercel.app npx vitest run tests/live-rematch.test.ts
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
  return { status: response.status, body: body as T, raw, cookie: setCookie.length ? setCookie[0].split(";")[0] : null };
}

interface QueueSnapshot {
  status: string;
  queueId: string | null;
  gameId: string | null;
}

async function demoPlayer(tag: string): Promise<string> {
  const name = `rematch${tag}${Math.random().toString(36).slice(2, 6)}`;
  const signIn = await api("/api/auth/demo", { method: "POST", body: { name } });
  expect(signIn.status, signIn.raw).toBe(200);
  if (!signIn.cookie) throw new Error("no session cookie");
  const onboard = await api("/api/onboarding", {
    method: "POST",
    cookie: signIn.cookie,
    body: { username: name, theme: "neon" },
  });
  expect(onboard.status, onboard.raw).toBe(200);
  return signIn.cookie;
}

describe.runIf(LIVE)("deployed play-again", () => {
  it("starts a fresh search after a matchmaking duel settles", { timeout: 120_000 }, async () => {
    const alpha = await demoPlayer("a");
    const beta = await demoPlayer("b");

    const first = await api<QueueSnapshot>("/api/matchmaking", {
      method: "POST",
      cookie: alpha,
      body: { entryXlm: 0, demo: true },
    });
    expect(first.body.status).toBe("searching");

    const second = await api<QueueSnapshot>("/api/matchmaking", {
      method: "POST",
      cookie: beta,
      body: { entryXlm: 0, demo: true },
    });
    expect(second.body.status).toBe("matched");

    const matched = await api<QueueSnapshot>("/api/matchmaking", { cookie: alpha });
    expect(matched.body.status).toBe("matched");
    const gameId = matched.body.gameId;
    expect(gameId).toBeTruthy();
    expect((await api<QueueSnapshot>("/api/matchmaking", { cookie: beta })).body.gameId).toBe(gameId);

    for (const cookie of [alpha, beta]) {
      const entry = await api(`/api/duels/${gameId}/entry`, { method: "POST", cookie, body: { action: "commit" } });
      expect(entry.status, entry.raw).toBe(200);
    }
    const started = await api(`/api/matches/${gameId}/start`, { method: "POST", cookie: alpha });
    expect(started.status, started.raw).toBe(200);

    const view = await api<{ schedule: ReturnType<typeof buildTargetSchedule>; game: { seed: string } }>(
      `/api/matches/${gameId}`,
      { cookie: alpha },
    );
    const hitsFor = (count: number): HitRecord[] =>
      view.body.schedule.slice(0, count).map((target) => ({ targetId: target.id, atMs: target.spawnAtMs + 160 }));

    const alphaHits = hitsFor(30);
    const betaHits = hitsFor(4);
    const alphaSubmit = await api<{ settled: boolean }>(`/api/matches/${gameId}/submit`, {
      method: "POST",
      cookie: alpha,
      body: {
        seat: 1,
        hits: alphaHits,
        misses: [],
        clientScore: scoreMatch(view.body.game.seed, { hits: alphaHits, misses: [] }).score,
      },
    });
    expect(alphaSubmit.status, alphaSubmit.raw).toBe(200);

    const betaSubmit = await api<{ settled: boolean }>(`/api/matches/${gameId}/submit`, {
      method: "POST",
      cookie: beta,
      body: {
        seat: 2,
        hits: betaHits,
        misses: [],
        clientScore: scoreMatch(view.body.game.seed, { hits: betaHits, misses: [] }).score,
      },
    });
    expect(betaSubmit.status, betaSubmit.raw).toBe(200);
    expect(betaSubmit.body.settled).toBe(true);

    // The finished duel is no longer offered back to either player.
    const afterAlpha = await api<QueueSnapshot>("/api/matchmaking", { cookie: alpha });
    expect(afterAlpha.body.status).toBe("idle");
    expect(afterAlpha.body.gameId).toBeNull();

    // "Play again" opens a new ticket with a new id, not the finished game.
    const again = await api<QueueSnapshot>("/api/matchmaking", {
      method: "POST",
      cookie: alpha,
      body: { entryXlm: 0, demo: true },
    });
    expect(again.body.status).toBe("searching");
    expect(again.body.gameId).toBeNull();
    expect(again.body.queueId).not.toBe(first.body.queueId);

    await api("/api/matchmaking", { method: "DELETE", cookie: alpha });
    await api("/api/matchmaking", { method: "DELETE", cookie: beta });
  });
});
