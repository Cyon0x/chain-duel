/**
 * Live treasury authorisation and bot-settlement accounting against a running
 * Chain Duel server, the deployed Soroban contract and Stellar Testnet.
 *
 * Opt in explicitly — it spends real Testnet XLM:
 *   CHAIN_DUEL_LIVE=1 npx vitest run tests/live-treasury.test.ts
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { buildTargetSchedule, scoreMatch } from "@/lib/game/pulse";
import type { HitRecord } from "@/lib/game/pulse";
import { ECONOMY, splitPool } from "@/lib/config/game";

const BASE = process.env.CHAIN_DUEL_LIVE_URL ?? "http://localhost:4310";
const LIVE = process.env.CHAIN_DUEL_LIVE === "1";
const ENTRY = 5 * 10_000_000;

function envFile(): Record<string, string> {
  try {
    const raw = readFileSync(`${process.cwd()}/.env.local`, "utf8");
    return Object.fromEntries(
      raw
        .split(/\r?\n/)
        .filter((line) => line && !line.startsWith("#") && line.includes("="))
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
        }),
    );
  } catch {
    return {};
  }
}

const adminSecret = process.env.CHAIN_DUEL_ADMIN_SECRET ?? envFile().SETTLEMENT_SECRET_KEY;
const adminKeypair = adminSecret ? Keypair.fromSecret(adminSecret) : null;

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
  const username = `tr${tag}${suffix}`;
  const signIn = await api("/api/auth/demo", { method: "POST", body: { name: `tr${tag}` } });
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

/** Signs in with a raw Stellar keypair exactly like Freighter would. */
async function walletSession(keypair: Keypair): Promise<string> {
  const challenge = await api<{ message: string }>("/api/auth/stellar/challenge", {
    method: "POST",
    body: { address: keypair.publicKey() },
  });
  expect(challenge.status, challenge.raw).toBe(200);
  const signer = keypair as unknown as { signMessage(message: Buffer): Uint8Array };
  const signature = Buffer.from(signer.signMessage(Buffer.from(challenge.body.message, "utf8"))).toString("base64");
  const verify = await api("/api/auth/stellar/verify", {
    method: "POST",
    body: {
      address: keypair.publicKey(),
      message: challenge.body.message,
      signature,
      signerAddress: keypair.publicKey(),
    },
  });
  expect(verify.status, verify.raw).toBe(200);
  if (!verify.cookie) throw new Error("no session cookie issued for wallet session");
  return verify.cookie;
}

/** Network fees the treasury wallet paid on its own transactions since `sinceIso`. */
async function feesPaidSince(address: string, sinceIso: string): Promise<number> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(
      `https://horizon-testnet.stellar.org/accounts/${address}/transactions?order=desc&limit=20`,
    );
    if (response.ok) {
      const page = (await response.json()) as {
        _embedded?: { records?: Array<{ source_account: string; created_at: string; fee_charged: string; successful: boolean }> };
      };
      const records = page._embedded?.records ?? [];
      const mine = records.filter(
        (row) => row.source_account === address && row.created_at >= sinceIso && row.successful,
      );
      if (mine.length > 0) return mine.reduce((total, row) => total + Number(row.fee_charged), 0);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return -1;
}

async function nativeBalance(address: string): Promise<number> {
  const response = await fetch(`https://horizon-testnet.stellar.org/accounts/${address}`);
  if (!response.ok) throw new Error(`horizon account lookup failed (${response.status})`);
  const body = (await response.json()) as { balances: Array<{ asset_type: string; balance: string }> };
  const native = body.balances.find((entry) => entry.asset_type === "native");
  if (!native) throw new Error("no native balance on account");
  return Math.round(Number(native.balance) * 10_000_000);
}

interface Snapshot {
  available: boolean;
  botLiquidityStroops: number;
  accruedFeesStroops: number;
  lockedEscrowStroops: number;
  contractBalanceStroops: number;
  treasuryAddress: string | null;
}

async function adminDashboard(cookie: string): Promise<{ authorized: boolean; dashboard: { snapshot: Snapshot; botMatches: Array<Record<string, number | string>> } }> {
  const response = await api<{ authorized: boolean; dashboard: { snapshot: Snapshot; botMatches: Array<Record<string, number | string>> } }>(
    "/api/treasury",
    { cookie },
  );
  expect(response.status, response.raw).toBe(200);
  return response.body;
}

describe.runIf(LIVE)("treasury authorisation", () => {
  it("never authorises players, strangers or anonymous callers", { timeout: 120_000 }, async () => {
    const anonymous = await api("/api/treasury/withdraw", { method: "POST", body: { amountXlm: 0.1 } });
    expect(anonymous.status).toBeGreaterThanOrEqual(401);

    const alpha = await createPlayer("w1");
    const beta = await createPlayer("w2");
    for (const player of [alpha, beta]) {
      const attempt = await api<{ error?: string }>("/api/treasury/withdraw", {
        method: "POST",
        cookie: player.cookie,
        body: { amountXlm: 0.1 },
      });
      expect(attempt.status, attempt.raw).toBe(403);
      expect(attempt.body.error ?? "").not.toMatch(/HostError|simulation failed/i);
    }

    // The API takes no destination — an attacker cannot redirect the payout.
    const withDestination = await api("/api/treasury/withdraw", {
      method: "POST",
      cookie: alpha.cookie,
      body: { amountXlm: 0.1, destination: Keypair.random().publicKey() },
    });
    expect(withDestination.status).toBe(403);

    // A genuine, correctly-signed wallet that is simply not the admin is refused.
    const stranger = Keypair.random();
    const strangerCookie = await walletSession(stranger);
    const strangerAttempt = await api("/api/treasury/withdraw", {
      method: "POST",
      cookie: strangerCookie,
      body: { amountXlm: 0.1 },
    });
    expect(strangerAttempt.status).toBe(403);

    const strangerDashboard = await api<{ authorized: boolean }>("/api/treasury", { cookie: strangerCookie });
    expect(strangerDashboard.body.authorized).toBe(false);
  });

  it.runIf(Boolean(adminKeypair))("allows the designated developer wallet to withdraw", { timeout: 120_000 }, async () => {
    const cookie = await walletSession(adminKeypair as Keypair);
    const before = await adminDashboard(cookie);
    expect(before.authorized).toBe(true);
    const admin = (adminKeypair as Keypair).publicKey();
    expect(before.dashboard.snapshot.treasuryAddress).toBe(admin);

    const available = before.dashboard.snapshot.accruedFeesStroops;
    if (available < 100_000) {
      // Nothing to withdraw yet — still assert the gate let the admin through.
      expect(available).toBeGreaterThanOrEqual(0);
      return;
    }
    const amountStroops = Math.min(100_000, available);
    const withdrawal = await api<{ txHash: string; explorerUrl: string; remaining: string }>(
      "/api/treasury/withdraw",
      { method: "POST", cookie, body: { amountXlm: amountStroops / 10_000_000 } },
    );
    expect(withdrawal.status, withdrawal.raw).toBe(200);
    expect(withdrawal.body.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(withdrawal.body.explorerUrl).toContain(withdrawal.body.txHash);

    const after = await adminDashboard(cookie);
    expect(after.dashboard.snapshot.accruedFeesStroops).toBe(available - amountStroops);
    const action = (after.dashboard as unknown as { adminActions: Array<{ action: string; tx_hash: string }> }).adminActions.find(
      (entry) => entry.tx_hash === withdrawal.body.txHash,
    );
    expect(action?.action).toBe("treasury_withdrawal");
  });
});

describe.runIf(LIVE)("bot settlement treasury accounting", () => {
  it("reconciles a computer match against on-chain treasury movement", { timeout: 240_000 }, async () => {
    if (!adminKeypair) throw new Error("CHAIN_DUEL_ADMIN_SECRET / SETTLEMENT_SECRET_KEY is required");
    const adminCookie = await walletSession(adminKeypair);
    const before = await adminDashboard(adminCookie);
    const treasuryAddress = before.dashboard.snapshot.treasuryAddress;
    if (!treasuryAddress) throw new Error("treasury address unavailable");
    const walletBefore = await nativeBalance(treasuryAddress);
    const startedAt = new Date().toISOString();

    const player = await createPlayer("b1");
    await friendbot(player.address);

    const created = await api<{ game: { id: string } }>("/api/duels", {
      method: "POST",
      cookie: player.cookie,
      body: { mode: "bot", entryXlm: 5 },
    });
    expect(created.status, created.raw).toBe(200);
    const gameId = created.body.game.id;

    const entry = await api<{ escrow: { txHash?: string } }>(`/api/duels/${gameId}/entry`, {
      method: "POST",
      cookie: player.cookie,
      body: { action: "commit", role: "creator" },
    });
    expect(entry.status, entry.raw).toBe(200);
    expect(entry.body.escrow.txHash).toMatch(/^[0-9a-f]{64}$/);

    const started = await api(`/api/matches/${gameId}/start`, { method: "POST", cookie: player.cookie });
    expect(started.status, started.raw).toBe(200);

    const view = await api<{ schedule: ReturnType<typeof buildTargetSchedule>; game: { seed: string } }>(
      `/api/matches/${gameId}`,
      { cookie: player.cookie },
    );
    const hits: HitRecord[] = view.body.schedule
      .slice(0, 25)
      .map((target) => ({ targetId: target.id, atMs: target.spawnAtMs + 150 }));
    const clientScore = scoreMatch(view.body.game.seed, { hits, misses: [] }).score;

    const submitted = await api<{ settled: boolean }>(`/api/matches/${gameId}/submit`, {
      method: "POST",
      cookie: player.cookie,
      body: { seat: 1, hits, misses: [], clientScore },
    });
    expect(submitted.status, submitted.raw).toBe(200);
    expect(submitted.body.settled).toBe(true);

    const after = await adminDashboard(adminCookie);
    const walletAfter = await nativeBalance(treasuryAddress);
    const match = after.dashboard.botMatches.find((row) => row.game_id === gameId);
    expect(match, JSON.stringify(after.dashboard.botMatches)).toBeTruthy();

    const entryStroops = ENTRY;
    const { fee, payout } = splitPool(entryStroops * 2, ECONOMY.feeBps);
    const deltaPool = after.dashboard.snapshot.botLiquidityStroops - before.dashboard.snapshot.botLiquidityStroops;
    const deltaFees = after.dashboard.snapshot.accruedFeesStroops - before.dashboard.snapshot.accruedFeesStroops;
    const deltaWallet = walletAfter - walletBefore;
    const treasuryDelta = Number(match!.treasury_delta_stroops);
    const feeStroops = Number(match!.fee_stroops);

    // The bot pool is debited by exactly the entry when the game is created.
    expect(deltaPool).toBe(-entryStroops);
    // The contract accrues the protocol fee on chain and the database agrees.
    expect(feeStroops).toBe(fee);
    expect(deltaFees).toBe(fee);

    if (match!.winner === "player") {
      expect(Number(match!.player_reward_stroops)).toBe(payout);
      expect(treasuryDelta).toBe(-entryStroops);
      // The player (not the treasury) receives the payout; the wallet only pays
      // the network fees for start/settlement.
      expect(Math.abs(deltaWallet)).toBeLessThan(500_000);
    } else {
      expect(match!.winner).toBe("bot");
      expect(Number(match!.player_reward_stroops)).toBe(0);
      expect(treasuryDelta).toBe(entryStroops - fee);
      expect(deltaWallet).toBeGreaterThan(0);
    }

    // Protocol-owned value (bot liquidity + accrued fees + treasury wallet)
    // changed by exactly treasury_delta + fee, minus the network fees the
    // treasury wallet paid to start and settle the match. Nothing is
    // unexplained: the reconciliation is exact, not a tolerance.
    const measured = deltaPool + deltaFees + deltaWallet;
    const networkFees = await feesPaidSince(treasuryAddress, startedAt);
    if (networkFees >= 0) {
      expect(measured).toBe(treasuryDelta + feeStroops - networkFees);
    } else {
      // Horizon had not indexed the transactions yet; the only permitted gap is
      // the (small) network fee, so a 0.1 XLM bound still catches real leakage.
      expect(Math.abs(measured - (treasuryDelta + feeStroops))).toBeLessThanOrEqual(1_000_000);
    }
  });
});
