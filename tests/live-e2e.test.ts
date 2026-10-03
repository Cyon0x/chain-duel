/**
 * Live end-to-end duel against a running Chain Duel server and the deployed
 * Soroban escrow contract on Stellar Testnet.
 *
 * Opt in explicitly — it spends real Testnet XLM:
 *   CHAIN_DUEL_LIVE=1 npx vitest run tests/live-e2e.test.ts
 *
 * Requires `npm run dev:webpack` to be running on http://localhost:4310.
 */
import { describe, expect, it } from "vitest";
import { buildTargetSchedule, scoreMatch } from "@/lib/game/pulse";
import type { HitRecord } from "@/lib/game/pulse";

const BASE = process.env.CHAIN_DUEL_LIVE_URL ?? "http://localhost:4310";
const LIVE = process.env.CHAIN_DUEL_LIVE === "1";

interface ApiResult<T> {
  status: number;
  body: T;
  cookie: string | null;
}

async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; cookie?: string | null } = {},
): Promise<ApiResult<T>> {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  const raw = response.headers.getSetCookie?.() ?? [];
  const cookie = raw.length > 0 ? raw[0].split(";")[0] : null;
  return { status: response.status, body: body as T, cookie };
}

function addressIn(value: unknown): string {
  const match = JSON.stringify(value).match(/G[A-Z2-7]{55}/);
  if (!match) throw new Error("no stellar address in payload");
  return match[0];
}

async function createPlayer(tag: string) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const signIn = await api("/api/auth/demo", { method: "POST", body: { name: `qa${tag}` } });
  expect(signIn.status, JSON.stringify(signIn.body)).toBe(200);
  const cookie = signIn.cookie;
  if (!cookie) throw new Error("no session cookie issued");
  const onboard = await api("/api/onboarding", {
    method: "POST",
    cookie,
    body: { username: `qa${tag}${suffix}`, theme: "void" },
  });
  expect(onboard.status, JSON.stringify(onboard.body)).toBe(200);
  const profile = await api("/api/profile", { cookie });
  return { cookie, address: addressIn(profile.body), username: `qa${tag}${suffix}` };
}

async function friendbot(address: string): Promise<void> {
  const response = await fetch(`https://friendbot.stellar.org?addr=${address}`);
  const text = await response.text();
  if (!response.ok && !/already/i.test(text)) throw new Error(`friendbot failed: ${text.slice(0, 200)}`);
}

describe.runIf(LIVE)("live duel against Testnet escrow", () => {
  it("escrows, settles and pays the winner on chain", { timeout: 180_000 }, async () => {
    const alpha = await createPlayer("a");
    const beta = await createPlayer("b");

    await friendbot(alpha.address);
    await friendbot(beta.address);

    // Creator locks 5 XLM of real Testnet XLM into the contract.
    const created = await api<{ game: { id: string; code: string; contract_game_id: string } }>("/api/duels", {
      method: "POST",
      cookie: alpha.cookie,
      body: { mode: "private", entryXlm: 5 },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const gameId = created.body.game.id;
    const code = created.body.game.code;

    const creatorEntry = await api<{ escrow: { mode: string; txHash?: string } }>(
      `/api/duels/${gameId}/entry`,
      { method: "POST", cookie: alpha.cookie, body: { action: "commit", role: "creator" } },
    );
    expect(creatorEntry.status, JSON.stringify(creatorEntry.body)).toBe(200);
    expect(creatorEntry.body.escrow.mode).toBe("confirmed");
    expect(creatorEntry.body.escrow.txHash).toMatch(/^[0-9a-f]{64}$/);

    const joined = await api<{ game: { id: string }; escrow: { mode: string; txHash?: string } }>(
      "/api/duels/join",
      { method: "POST", cookie: beta.cookie, body: { code } },
    );
    expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    expect(joined.body.escrow.txHash).toMatch(/^[0-9a-f]{64}$/);

    // Retrying the joiner's entry must be idempotent: the entry is already
    // locked on chain, so the retry returns the original transaction instead of
    // charging again or failing with a raw contract error.
    const joinerEntry = await api<{ escrow: { mode: string; txHash?: string } }>(
      `/api/duels/${gameId}/entry`,
      { method: "POST", cookie: beta.cookie, body: { action: "commit", role: "joiner" } },
    );
    expect(joinerEntry.status, JSON.stringify(joinerEntry.body)).toBe(200);
    expect(joinerEntry.body.escrow.mode).toBe("confirmed");
    expect(joinerEntry.body.escrow.txHash).toBe(joined.body.escrow.txHash);

    const started = await api(`/api/matches/${gameId}/start`, { method: "POST", cookie: alpha.cookie });
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    const view = await api<{ schedule: ReturnType<typeof buildTargetSchedule>; game: { seed: string } }>(
      `/api/matches/${gameId}`,
      { cookie: alpha.cookie },
    );
    expect(view.status).toBe(200);

    const hitsFor = (count: number): HitRecord[] =>
      view.body.schedule.slice(0, count).map((target) => ({ targetId: target.id, atMs: target.spawnAtMs + 150 }));

    const alphaHits = hitsFor(40);
    const betaHits = hitsFor(6);
    const alphaScore = scoreMatch(view.body.game.seed, { hits: alphaHits, misses: [] }).score;
    const betaScore = scoreMatch(view.body.game.seed, { hits: betaHits, misses: [] }).score;
    expect(alphaScore).toBeGreaterThan(betaScore);

    const alphaSubmit = await api<{ settled: boolean }>(`/api/matches/${gameId}/submit`, {
      method: "POST",
      cookie: alpha.cookie,
      body: { seat: 1, hits: alphaHits, misses: [], clientScore: alphaScore },
    });
    expect(alphaSubmit.status, JSON.stringify(alphaSubmit.body)).toBe(200);
    expect(alphaSubmit.body.settled).toBe(false);

    const betaSubmit = await api<{ settled: boolean }>(`/api/matches/${gameId}/submit`, {
      method: "POST",
      cookie: beta.cookie,
      body: { seat: 2, hits: betaHits, misses: [], clientScore: betaScore },
    });
    expect(betaSubmit.status, JSON.stringify(betaSubmit.body)).toBe(200);
    expect(betaSubmit.body.settled).toBe(true);

    const settled = await api<{ game: { status: string; settle_tx_hash: string | null } }>(
      `/api/matches/${gameId}`,
      { cookie: alpha.cookie },
    );
    expect(settled.body.game.status).toBe("settled");
    expect(settled.body.game.settle_tx_hash).toMatch(/^[0-9a-f]{64}$/);

    const transactions = await api<{ transactions: Array<{ kind: string; status: string; tx_hash: string | null }> }>(
      "/api/transactions",
      { cookie: alpha.cookie },
    );
    const payout = transactions.body.transactions.find((entry) => entry.kind === "payout");
    expect(payout, JSON.stringify(transactions.body)).toBeTruthy();
    expect(payout?.status).toBe("confirmed");
    expect(payout?.tx_hash).toBe(settled.body.game.settle_tx_hash);
  });

  it("settles a computer duel against the real bot treasury", { timeout: 180_000 }, async () => {
    const player = await createPlayer("c");
    await friendbot(player.address);

    const created = await api<{ game: { id: string } }>("/api/duels", {
      method: "POST",
      cookie: player.cookie,
      body: { mode: "bot", entryXlm: 5 },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const gameId = created.body.game.id;

    const entry = await api<{ escrow: { mode: string; txHash?: string } }>(`/api/duels/${gameId}/entry`, {
      method: "POST",
      cookie: player.cookie,
      body: { action: "commit", role: "creator" },
    });
    expect(entry.status, JSON.stringify(entry.body)).toBe(200);
    expect(entry.body.escrow.txHash).toMatch(/^[0-9a-f]{64}$/);

    const started = await api(`/api/matches/${gameId}/start`, { method: "POST", cookie: player.cookie });
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    const view = await api<{ schedule: ReturnType<typeof buildTargetSchedule>; game: { seed: string } }>(
      `/api/matches/${gameId}`,
      { cookie: player.cookie },
    );
    const hits: HitRecord[] = view.body.schedule
      .slice(0, 25)
      .map((target) => ({ targetId: target.id, atMs: target.spawnAtMs + 150 }));
    const clientScore = scoreMatch(view.body.game.seed, { hits, misses: [] }).score;

    const submitted = await api<{ settled: boolean; game: { status: string } }>(`/api/matches/${gameId}/submit`, {
      method: "POST",
      cookie: player.cookie,
      body: { seat: 1, hits, misses: [], clientScore },
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.body.settled).toBe(true);
    expect(submitted.body.game.status).toBe("settled");

    const finalView = await api<{
      game: { mode: string; status: string; winner_id: string | null; settle_tx_hash: string | null };
      players: Array<{ seat: number; is_bot: number; score: number; hits: number }>;
    }>(`/api/matches/${gameId}`, { cookie: player.cookie });
    expect(finalView.body.game.settle_tx_hash).toMatch(/^[0-9a-f]{64}$/);
    // The computer genuinely played the same engine: it hit real targets and
    // finished with a real score, rather than a pre-baked result screen.
    const bot = finalView.body.players.find((entry) => entry.is_bot === 1);
    expect(bot, JSON.stringify(finalView.body)).toBeTruthy();
    expect(bot?.hits ?? 0).toBeGreaterThan(0);
    expect(bot?.score ?? 0).toBeGreaterThan(0);

    const transactions = await api<{ transactions: Array<{ kind: string; status: string; tx_hash: string | null }> }>(
      "/api/transactions",
      { cookie: player.cookie },
    );
    const entryLine = transactions.body.transactions.find((row) => row.kind === "entry");
    expect(entryLine?.status).toBe("confirmed");
    expect(entryLine?.tx_hash).toMatch(/^[0-9a-f]{64}$/);
    // A player win is paid out of the real bot treasury and is only ever
    // recorded once the Stellar settlement has confirmed.
    if (finalView.body.game.winner_id) {
      const botLine = transactions.body.transactions.find((row) => row.kind === "bot_settlement");
      expect(botLine, JSON.stringify(transactions.body)).toBeTruthy();
      expect(botLine?.status).toBe("confirmed");
    }
  });
});
