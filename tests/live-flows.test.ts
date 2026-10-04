/**
 * Live end-to-end flows against a running server and the deployed Soroban
 * escrow contract on Stellar Testnet.
 *
 * Opt in explicitly — it spends real Testnet XLM:
 *   CHAIN_DUEL_LIVE=1 npx vitest run tests/live-flows.test.ts
 *
 * Covers the paths the duel test does not: random matchmaking, targeted
 * player challenges, and creator cancellation with an on-chain refund.
 */
import { describe, expect, it } from "vitest";
import { buildTargetSchedule, scoreMatch } from "@/lib/game/pulse";
import type { HitRecord } from "@/lib/game/pulse";

const BASE = process.env.CHAIN_DUEL_LIVE_URL ?? "http://localhost:4310";
const LIVE = process.env.CHAIN_DUEL_LIVE === "1";

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
  return { status: response.status, body: body as T, cookie: setCookie.length ? setCookie[0].split(";")[0] : null, raw };
}

function addressIn(value: unknown): string {
  const match = JSON.stringify(value).match(/G[A-Z2-7]{55}/);
  if (!match) throw new Error("no stellar address in payload");
  return match[0];
}

async function createPlayer(tag: string) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const username = `lf${tag}${suffix}`;
  const signIn = await api("/api/auth/demo", { method: "POST", body: { name: `lf${tag}` } });
  expect(signIn.status, signIn.raw).toBe(200);
  const cookie = signIn.cookie;
  if (!cookie) throw new Error("no session cookie issued");
  const onboard = await api("/api/onboarding", {
    method: "POST",
    cookie,
    body: { username, theme: "circuit" },
  });
  expect(onboard.status, onboard.raw).toBe(200);
  const profile = await api("/api/profile", { cookie });
  return { cookie, address: addressIn(profile.body), username, userId: (profile.body as { profile: { user_id: string } }).profile.user_id };
}

async function friendbot(address: string): Promise<void> {
  const response = await fetch(`https://friendbot.stellar.org?addr=${address}`);
  const text = await response.text();
  if (!response.ok && !/already/i.test(text)) throw new Error(`friendbot failed: ${text.slice(0, 200)}`);
}

/** Locks both entries, starts the match, submits scores and waits for settlement. */
async function playMatch(input: {
  gameId: string;
  creator: { cookie: string };
  joiner: { cookie: string };
  creatorHits: number;
  joinerHits: number;
}) {
  const creatorEntry = await api<{ escrow: { mode: string; txHash?: string } }>(
    `/api/duels/${input.gameId}/entry`,
    { method: "POST", cookie: input.creator.cookie, body: { action: "commit" } },
  );
  expect(creatorEntry.status, creatorEntry.raw).toBe(200);
  expect(creatorEntry.body.escrow.mode).toBe("confirmed");
  expect(creatorEntry.body.escrow.txHash).toMatch(/^[0-9a-f]{64}$/);

  const joinerEntry = await api<{ escrow: { mode: string; txHash?: string } }>(
    `/api/duels/${input.gameId}/entry`,
    { method: "POST", cookie: input.joiner.cookie, body: { action: "commit" } },
  );
  expect(joinerEntry.status, joinerEntry.raw).toBe(200);
  expect(joinerEntry.body.escrow.txHash).toMatch(/^[0-9a-f]{64}$/);

  const started = await api(`/api/matches/${input.gameId}/start`, { method: "POST", cookie: input.creator.cookie });
  expect(started.status, started.raw).toBe(200);

  const view = await api<{ schedule: ReturnType<typeof buildTargetSchedule>; game: { seed: string } }>(
    `/api/matches/${input.gameId}`,
    { cookie: input.creator.cookie },
  );
  expect(view.status, view.raw).toBe(200);

  const hitsFor = (count: number): HitRecord[] =>
    view.body.schedule.slice(0, count).map((target) => ({ targetId: target.id, atMs: target.spawnAtMs + 150 }));

  const creatorHits = hitsFor(input.creatorHits);
  const joinerHits = hitsFor(input.joinerHits);

  const first = await api<{ settled: boolean }>(`/api/matches/${input.gameId}/submit`, {
    method: "POST",
    cookie: input.creator.cookie,
    body: {
      seat: 1,
      hits: creatorHits,
      misses: [],
      clientScore: scoreMatch(view.body.game.seed, { hits: creatorHits, misses: [] }).score,
    },
  });
  expect(first.status, first.raw).toBe(200);

  const second = await api<{ settled: boolean }>(`/api/matches/${input.gameId}/submit`, {
    method: "POST",
    cookie: input.joiner.cookie,
    body: {
      seat: 2,
      hits: joinerHits,
      misses: [],
      clientScore: scoreMatch(view.body.game.seed, { hits: joinerHits, misses: [] }).score,
    },
  });
  expect(second.status, second.raw).toBe(200);
  expect(second.body.settled).toBe(true);
  return { creatorHits, joinerHits };
}

describe.runIf(LIVE)("live multi-player flows", () => {
  it("matches two queued players and settles the duel on chain", { timeout: 300_000 }, async () => {
    const alpha = await createPlayer("q1");
    const beta = await createPlayer("q2");
    await friendbot(alpha.address);
    await friendbot(beta.address);

    const first = await api<{ status: string; queueId: string | null }>("/api/matchmaking", {
      method: "POST",
      cookie: alpha.cookie,
      body: { entryXlm: 5 },
    });
    expect(first.status, first.raw).toBe(200);
    expect(first.body.status).toBe("searching");

    const second = await api<{ status: string; gameId: string | null }>("/api/matchmaking", {
      method: "POST",
      cookie: beta.cookie,
      body: { entryXlm: 5 },
    });
    expect(second.status, second.raw).toBe(200);

    // Whoever queued second triggers the pairing; the other learns on poll.
    const alphaStatus = await api<{ status: string; gameId: string | null }>("/api/matchmaking", {
      cookie: alpha.cookie,
    });
    const betaStatus = await api<{ status: string; gameId: string | null }>("/api/matchmaking", {
      cookie: beta.cookie,
    });
    expect(alphaStatus.body.status, alphaStatus.raw).toBe("matched");
    expect(betaStatus.body.status, betaStatus.raw).toBe("matched");
    const gameId = alphaStatus.body.gameId;
    expect(gameId).toBeTruthy();
    // Both players must be pointed at the SAME duel.
    expect(betaStatus.body.gameId).toBe(gameId);

    await playMatch({ gameId: gameId as string, creator: alpha, joiner: beta, creatorHits: 40, joinerHits: 5 });

    const settled = await api<{ game: { status: string; settle_tx_hash: string | null } }>(
      `/api/matches/${gameId}`,
      { cookie: alpha.cookie },
    );
    expect(settled.body.game.status).toBe("settled");
    expect(settled.body.game.settle_tx_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("delivers a targeted challenge, accepts it, and completes the invitation", { timeout: 300_000 }, async () => {
    const alpha = await createPlayer("c1");
    const beta = await createPlayer("c2");
    await friendbot(alpha.address);
    await friendbot(beta.address);

    const challenge = await api<{ game: { id: string }; invite: { id: string; status: string } }>("/api/duels", {
      method: "POST",
      cookie: alpha.cookie,
      body: { mode: "pvp", entryXlm: 5, invitedUsername: beta.username },
    });
    expect(challenge.status, challenge.raw).toBe(200);
    const gameId = challenge.body.game.id;

    // The challenger has not staked yet, so accepting now must fail with a
    // plain message and leave the invitation open — never a raw contract error.
    const premature = await api<{ error?: string }>(`/api/invites/${challenge.body.invite.id}`, {
      method: "POST",
      cookie: beta.cookie,
      body: { accept: true },
    });
    expect(premature.status).toBeGreaterThanOrEqual(400);
    expect(premature.body.error ?? "").not.toMatch(/HostError|simulation failed/i);

    // Creator locks their side (this is what create_game does on chain).
    const creatorEntry = await api<{ escrow: { txHash?: string } }>(`/api/duels/${gameId}/entry`, {
      method: "POST",
      cookie: alpha.cookie,
      body: { action: "commit" },
    });
    expect(creatorEntry.status, creatorEntry.raw).toBe(200);
    expect(creatorEntry.body.escrow.txHash).toMatch(/^[0-9a-f]{64}$/);

    const inbox = await api<{ invites: Array<{ id: string; creator_id: string; status: string }> }>("/api/invites", {
      cookie: beta.cookie,
    });
    expect(inbox.status, inbox.raw).toBe(200);
    expect(inbox.body.invites.length, inbox.raw).toBeGreaterThan(0);
    const invite = inbox.body.invites.find((entry) => entry.id === challenge.body.invite.id);
    expect(invite, inbox.raw).toBeTruthy();

    // A different player must not be able to accept someone else's challenge.
    const intruder = await createPlayer("c3");
    const stolen = await api(`/api/invites/${challenge.body.invite.id}`, {
      method: "POST",
      cookie: intruder.cookie,
      body: { accept: true },
    });
    expect(stolen.status).toBeGreaterThanOrEqual(400);

    const accepted = await api<{ accepted: boolean; escrow?: { txHash?: string } }>(
      `/api/invites/${challenge.body.invite.id}`,
      { method: "POST", cookie: beta.cookie, body: { accept: true } },
    );
    expect(accepted.status, accepted.raw).toBe(200);
    expect(accepted.body.accepted).toBe(true);

    await playMatch({ gameId, creator: alpha, joiner: beta, creatorHits: 40, joinerHits: 4 });

    const settled = await api<{ game: { status: string; settle_tx_hash: string | null } }>(`/api/matches/${gameId}`, {
      cookie: alpha.cookie,
    });
    expect(settled.body.game.status).toBe("settled");

    const inboxAfter = await api<{ invites: Array<{ id: string; status: string }> }>("/api/invites", {
      cookie: beta.cookie,
    });
    const resolved = inboxAfter.body.invites.find((entry) => entry.id === challenge.body.invite.id);
    expect(resolved, inboxAfter.raw).toBeFalsy();
  });

  it("refunds the creator when an unjoined private duel is cancelled", { timeout: 300_000 }, async () => {
    const alpha = await createPlayer("r1");
    await friendbot(alpha.address);

    const created = await api<{ game: { id: string } }>("/api/duels", {
      method: "POST",
      cookie: alpha.cookie,
      body: { mode: "private", entryXlm: 5 },
    });
    expect(created.status, created.raw).toBe(200);
    const gameId = created.body.game.id;

    const entry = await api<{ escrow: { mode: string; txHash?: string } }>(`/api/duels/${gameId}/entry`, {
      method: "POST",
      cookie: alpha.cookie,
      body: { action: "commit" },
    });
    expect(entry.status, entry.raw).toBe(200);
    expect(entry.body.escrow.txHash).toMatch(/^[0-9a-f]{64}$/);

    const cancelled = await api<{ game: { status: string } }>(`/api/duels/${gameId}`, {
      method: "DELETE",
      cookie: alpha.cookie,
    });
    expect(cancelled.status, cancelled.raw).toBe(200);

    const transactions = await api<{ transactions: Array<{ kind: string; status: string; tx_hash: string | null }> }>(
      "/api/transactions",
      { cookie: alpha.cookie },
    );
    const refund = transactions.body.transactions.find((row) => row.kind === "refund");
    expect(refund, transactions.raw).toBeTruthy();
    expect(refund?.status).toBe("confirmed");
    expect(refund?.tx_hash).toMatch(/^[0-9a-f]{64}$/);

    // Funds must not stay trapped: the refund is a real Stellar transaction.
    const after = await api<{ game: { status: string } }>(`/api/matches/${gameId}`, { cookie: alpha.cookie });
    expect(["cancelled", "refunded"]).toContain(after.body.game.status);
  });
});
