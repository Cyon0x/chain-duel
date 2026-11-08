/**
 * Live staking verification against a running server and the deployed Soroban
 * escrow contract on Stellar Testnet. Proves that the selected stake (preset or
 * custom) is the exact amount escrowed, that the pool is derived from it, and
 * that the 90/10 winner/protocol split is applied.
 *
 * Opt in explicitly — it spends real Testnet XLM:
 *   CHAIN_DUEL_LIVE=1 npx vitest run tests/live-stake.test.ts
 */
import { describe, expect, it } from "vitest";
import { buildTargetSchedule, scoreMatch } from "@/lib/game/pulse";
import type { HitRecord } from "@/lib/game/pulse";
import { formatXlm, xlmToStroops } from "@/lib/config/game";
import { Account, Asset, Contract, Keypair, Networks, Operation, TransactionBuilder, nativeToScVal, rpc, scValToNative } from "@stellar/stellar-sdk";

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
  const username = `st${tag}${suffix}`;
  const signIn = await api("/api/auth/demo", { method: "POST", body: { name: `st${tag}` } });
  expect(signIn.status, signIn.raw).toBe(200);
  const cookie = signIn.cookie;
  if (!cookie) throw new Error("no session cookie issued");
  const onboard = await api("/api/onboarding", { method: "POST", cookie, body: { username, theme: "neon" } });
  expect(onboard.status, onboard.raw).toBe(200);
  const profile = await api("/api/profile", { cookie });
  return { cookie, address: addressIn(profile.body), username };
}

async function friendbot(address: string): Promise<void> {
  const response = await fetch(`https://friendbot.stellar.org?addr=${address}`);
  const text = await response.text();
  if (!response.ok && !/already/i.test(text)) throw new Error(`friendbot failed: ${text.slice(0, 200)}`);
}

/** Friendbot gives exactly 10,000 XLM; a maximum entry also needs account reserves and fees. */
async function topUpReserve(address: string) {
  const donor = Keypair.random();
  await friendbot(donor.publicKey());
  const response = await fetch(`https://horizon-testnet.stellar.org/accounts/${donor.publicKey()}`);
  const account = await response.json() as { sequence: string };
  const payment = new TransactionBuilder(new Account(donor.publicKey(), account.sequence), { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination: address, asset: Asset.native(), amount: "100" })).setTimeout(60).build();
  payment.sign(donor);
  const sent = await fetch("https://horizon-testnet.stellar.org/transactions", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ tx: payment.toXDR() }) });
  expect(sent.ok, await sent.text()).toBe(true);
}

interface GameView {
  id: string;
  code: string;
  status: string;
  entry_stroops: number;
  pool_stroops: number;
  payout_stroops: number;
  fee_stroops: number;
  settle_tx_hash: string | null;
  winner_id: string | null;
  contract_game_id: string;
}

async function playAndSettle(gameId: string, creator: { cookie: string }, joiner: { cookie: string }) {
  const view = await api<{ schedule: ReturnType<typeof buildTargetSchedule>; game: { seed: string } }>(
    `/api/matches/${gameId}`,
    { cookie: creator.cookie },
  );
  expect(view.status, view.raw).toBe(200);

  const hitsFor = (count: number): HitRecord[] =>
    view.body.schedule.slice(0, count).map((target) => ({ targetId: target.id, atMs: target.spawnAtMs + 150 }));
  const creatorHits = hitsFor(40);
  const joinerHits = hitsFor(5);

  const first = await api(`/api/matches/${gameId}/submit`, {
    method: "POST",
    cookie: creator.cookie,
    body: {
      seat: 1,
      hits: creatorHits,
      misses: [],
      clientScore: scoreMatch(view.body.game.seed, { hits: creatorHits, misses: [] }).score,
    },
  });
  expect(first.status, first.raw).toBe(200);

  const second = await api(`/api/matches/${gameId}/submit`, {
    method: "POST",
    cookie: joiner.cookie,
    body: {
      seat: 2,
      hits: joinerHits,
      misses: [],
      clientScore: scoreMatch(view.body.game.seed, { hits: joinerHits, misses: [] }).score,
    },
  });
  expect(second.status, second.raw).toBe(200);
}

/** Runs the full create → escrow → join → play → settle flow at a given stake. */
async function runStakedDuel(entryXlm: number, tag: string) {
  const alpha = await createPlayer(`${tag}a`);
  const beta = await createPlayer(`${tag}b`);
  await friendbot(alpha.address);
  await friendbot(beta.address);
  if (entryXlm === 10_000) {
    await topUpReserve(alpha.address);
    await topUpReserve(beta.address);
  }

  const created = await api<{ game: GameView }>("/api/duels", {
    method: "POST",
    cookie: alpha.cookie,
    body: { mode: "private", entryXlm },
  });
  expect(created.status, created.raw).toBe(200);
  const gameId = created.body.game.id;
  const code = created.body.game.code;

  const creatorEntry = await api<{ escrow: { mode: string; txHash?: string } }>(`/api/duels/${gameId}/entry`, {
    method: "POST",
    cookie: alpha.cookie,
    body: { action: "commit", role: "creator" },
  });
  expect(creatorEntry.status, creatorEntry.raw).toBe(200);
  expect(creatorEntry.body.escrow.txHash).toMatch(/^[0-9a-f]{64}$/);

  // The invite code must resolve to the SAME arena the creator opened.
  const joined = await api<{ game: GameView }>("/api/duels/join", {
    method: "POST",
    cookie: beta.cookie,
    body: { code },
  });
  expect(joined.status, joined.raw).toBe(200);
  expect(joined.body.game.id).toBe(gameId);

  const afterJoin = await api<{ game: GameView; players: unknown[] }>(`/api/matches/${gameId}`, {
    cookie: alpha.cookie,
  });
  expect(afterJoin.body.game.entry_stroops).toBe(xlmToStroops(entryXlm));
  expect(afterJoin.body.players).toHaveLength(2);

  // A third player must not be able to spawn a second arena from the same code.
  const third = await createPlayer(`${tag}c`);
  await friendbot(third.address);
  const rejected = await api(`/api/duels/join`, { method: "POST", cookie: third.cookie, body: { code } });
  expect(rejected.status).toBeGreaterThanOrEqual(400);

  const started = await api(`/api/matches/${gameId}/start`, { method: "POST", cookie: alpha.cookie });
  expect(started.status, started.raw).toBe(200);
  await playAndSettle(gameId, alpha, beta);

  const settled = await api<{ game: GameView }>(`/api/matches/${gameId}`, { cookie: alpha.cookie });
  expect(settled.body.game.status).toBe("settled");
  expect(settled.body.game.settle_tx_hash).toMatch(/^[0-9a-f]{64}$/);
  // Read the deployed contract independently of the application's database.
  if (process.env.CHAIN_DUEL_LIVE_CONTRACT_ID) {
    const server = new rpc.Server("https://soroban-testnet.stellar.org");
    const account = await server.getAccount(alpha.address);
    const read = new TransactionBuilder(account, { fee: "100", networkPassphrase: Networks.TESTNET })
      .addOperation(new Contract(process.env.CHAIN_DUEL_LIVE_CONTRACT_ID).call("get_game", nativeToScVal(Buffer.from(settled.body.game.contract_game_id, "hex"), { type: "bytes" }))).setTimeout(60).build();
    const result = await server.simulateTransaction(read);
    expect(rpc.Api.isSimulationError(result), "Independent on-chain game read must succeed").toBe(false);
    if (rpc.Api.isSimulationSuccess(result) && result.result) {
      const game = scValToNative(result.result.retval) as { entry_amount: bigint; escrow: bigint; payout: bigint; fee: bigint; status: number };
      expect(game.entry_amount).toBe(BigInt(xlmToStroops(entryXlm)));
      expect(game.escrow).toBe(BigInt(xlmToStroops(entryXlm) * 2));
      expect(game.payout).toBe(BigInt(settled.body.game.payout_stroops));
      expect(game.fee).toBe(BigInt(settled.body.game.fee_stroops));
      expect(game.status).toBe(4);
    }
  }
  console.log(JSON.stringify({ entryXlm, poolStroops: settled.body.game.pool_stroops, payoutStroops: settled.body.game.payout_stroops, feeStroops: settled.body.game.fee_stroops, settleTxHash: settled.body.game.settle_tx_hash }));
  return { alpha, settled: settled.body.game };
}

describe.runIf(LIVE)("live staking", () => {
  it("rejects a stake above the maximum and non-positive stakes", async () => {
    const player = await createPlayer("bad");
    const tooBig = await api<{ code: string }>("/api/duels", {
      method: "POST",
      cookie: player.cookie,
      body: { mode: "private", entryXlm: 10001 },
    });
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.code).toBe("invalid_entry");

    const zero = await api<{ code: string }>("/api/duels", {
      method: "POST",
      cookie: player.cookie,
      body: { mode: "private", entryXlm: 0 },
    });
    expect(zero.status).toBe(400);
    expect(zero.body.code).toBe("invalid_entry");

    const tooPrecise = await api<{ code: string }>("/api/duels", {
      method: "POST",
      cookie: player.cookie,
      body: { mode: "private", entryXlm: 25.00000001 },
    });
    expect(tooPrecise.status).toBe(400);
    expect(tooPrecise.body.code).toBe("invalid_entry");
  });

  it("escrows a 25 XLM minimum and settles a 45 / 5 split", { timeout: 300_000 }, async () => {
    const { settled } = await runStakedDuel(25, "p25");
    expect(settled.entry_stroops).toBe(xlmToStroops(25));
    expect(settled.pool_stroops).toBe(xlmToStroops(50));
    expect(settled.payout_stroops).toBe(xlmToStroops(45));
    expect(settled.fee_stroops).toBe(xlmToStroops(5));
    expect(formatXlm(settled.payout_stroops)).toBe("45");
    expect(formatXlm(settled.fee_stroops)).toBe("5");
  });

  it("escrows a custom 125.5 XLM stake with exact stroop precision", { timeout: 300_000 }, async () => {
    const { settled } = await runStakedDuel(125.5, "pc");
    expect(settled.entry_stroops).toBe(xlmToStroops(125.5));
    expect(settled.pool_stroops).toBe(xlmToStroops(251));
    expect(settled.payout_stroops).toBe(xlmToStroops(225.9));
    expect(settled.fee_stroops).toBe(xlmToStroops(25.1));
  });

  it("records the actual stake in the player's transaction history", { timeout: 300_000 }, async () => {
    const { alpha, settled } = await runStakedDuel(50, "ph");
    const transactions = await api<{ transactions: Array<{ kind: string; amount_stroops: number; game_id: string }> }>(
      "/api/transactions",
      { cookie: alpha.cookie },
    );
    const entry = transactions.body.transactions.find((row) => row.kind === "entry" && row.game_id === settled.id);
    expect(entry, JSON.stringify(transactions.body)).toBeTruthy();
    expect(entry?.amount_stroops).toBe(xlmToStroops(50));
  });

  it("escrows 10,000 XLM from each player and settles the full 20,000 XLM pool", { timeout: 300_000 }, async () => {
    const { settled } = await runStakedDuel(10_000, "max");
    expect(settled.entry_stroops).toBe(xlmToStroops(10_000));
    expect(settled.pool_stroops).toBe(xlmToStroops(20_000));
    expect(settled.payout_stroops).toBe(xlmToStroops(18_000));
    expect(settled.fee_stroops).toBe(xlmToStroops(2_000));
  });
});
