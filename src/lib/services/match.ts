import "server-only";
import { db, nowIso } from "../db";
import {
  addGamePlayer,
  appendGameEvent,
  findGameById,
  findGamePlayer,
  listGameEvents,
  listGamePlayers,
  recordPlayerResult,
  recordRating,
  recordReputation,
  recordBotMatch,
  completeQueueEntriesForGame,
  transitionGame,
  updateGame,
  upsertMatch,
} from "../db/repositories/duel";
import { createTransaction, getSetting } from "../db/repositories/economy";
import { findProfile, primaryWallet, unlockAchievement, updateProfile } from "../db/repositories/identity";
import type { GameRow, GamePlayerRow, SqlDriver } from "../db/types";
import { PULSE_DUEL, REPUTATION, splitPool, stroopsToXlm } from "../config/game";
import { explorerTxUrl } from "../config/stellar";
import { evaluateAchievements, applyElo } from "../game/rating";
import { buildTargetSchedule, theoreticalMaxScore, type TargetSpec } from "../game/pulse";
import { verifySubmission, type SubmissionPayload } from "../game/verify";
import { PulseBot, drawBotOutcome, type BotOutcome } from "../game/bot";
import { DEFAULT_BOT } from "../config/game";
import type { BotState } from "../game/bot";
import { beginOnChainGame, settleOnChain, messageOf } from "./escrow";
import { recordBotTreasuryMovement } from "./treasury";
import { ChainDuelError } from "./errors";

export function botSeatId(): string {
  return `bot:${DEFAULT_BOT.id}`;
}

export interface GameView {
  game: GameRow;
  players: Array<GamePlayerRow & { username: string; avatar: string | null; rating: number }>;
  botScore: number | null;
  serverTimeMs: number;
  /** The deterministic target stream — identical for both players. */
  schedule: TargetSpec[];
  /** Latest provisional scores keyed by seat. Never used for settlement. */
  liveScores: Record<string, number>;
  /** Epoch ms at which the match clock reaches zero (after the countdown). */
  startAtMs: number | null;
  countdownMs: number;
  maxScore: number;
  /** Whether each seat has already locked its entry. */
  escrow: { creator: boolean; joiner: boolean };
}

interface ProgressEvent {
  score?: number;
  combo?: number;
  hits?: number;
  misses?: number;
  atMs?: number;
}

export async function loadGameView(gameId: string): Promise<GameView | null> {
  const database = await db();
  const game = await findGameById(database, gameId);
  if (!game) return null;
  const rows = await listGamePlayers(database, game.id);
  const players = [];
  for (const row of rows) {
    if (row.is_bot === 1) {
      players.push({ ...row, username: DEFAULT_BOT.name, avatar: null, rating: 0 });
      continue;
    }
    const profile = await findProfile(database, row.user_id);
    players.push({
      ...row,
      username: profile?.username ?? "Player",
      avatar: profile?.avatar ?? null,
      rating: profile?.rating ?? 1000,
    });
  }

  let botScore: number | null = null;
  if (game.mode === "bot" && game.status === "active") {
    const bot = await botSnapshotFor(game, players);
    botScore = bot?.score ?? null;
    if (bot) await persistBotState(game, bot.state);
  }

  const liveScores = await liveScoresFor(database, game.id);
  const startAtMs = game.started_at ? new Date(game.started_at).getTime() : null;

  return {
    game,
    players,
    botScore,
    serverTimeMs: Date.now(),
    schedule: buildTargetSchedule(game.seed, game.duration_ms),
    liveScores,
    startAtMs,
    countdownMs: PULSE_DUEL.countdownMs,
    maxScore: theoreticalMaxScore(buildTargetSchedule(game.seed, game.duration_ms)),
    escrow: {
      creator: Boolean(game.demo) || Boolean(game.create_tx_hash),
      joiner: Boolean(game.demo) || Boolean(game.join_tx_hash),
    },
  };
}

/**
 * Provisional in-progress scores, read from lightweight `progress` events.
 *
 * These exist purely so the HUD can show a live opponent. Settlement never
 * reads them — it only ever uses the verified result written by `submitResult`.
 */
async function liveScoresFor(
  database: Awaited<ReturnType<typeof db>>,
  gameId: string,
): Promise<Record<string, number>> {
  const events = await listGameEvents(database, gameId);
  const scores: Record<string, number> = {};
  for (const event of events) {
    if (event.type !== "progress" || event.seat === null) continue;
    const parsed = safeParseProgress(event.payload);
    if (parsed && Number.isFinite(parsed.score)) scores[String(event.seat)] = Number(parsed.score);
  }
  return scores;
}

function safeParseProgress(payload: string): ProgressEvent | null {
  try {
    const value = JSON.parse(payload) as ProgressEvent;
    return typeof value === "object" && value !== null ? value : null;
  } catch {
    return null;
  }
}

/** Records a provisional score snapshot from a player's client mid-duel. */
export async function recordProgress(input: {
  gameId: string;
  userId: string;
  score: number;
  combo?: number;
  hits?: number;
  misses?: number;
  atMs?: number;
}): Promise<void> {
  const database = await db();
  const game = await findGameById(database, input.gameId);
  if (!game || game.status !== "active") return;
  const player = await findGamePlayer(database, game.id, input.userId);
  if (!player) return;
  const score = Math.max(0, Math.min(Math.round(Number(input.score) || 0), 1_000_000));
  await appendGameEvent(database, {
    gameId: game.id,
    seq: Date.now() % 1_000_000,
    type: "progress",
    seat: player.seat,
    payload: {
      score,
      combo: Math.round(Number(input.combo) || 0),
      hits: Math.round(Number(input.hits) || 0),
      misses: Math.round(Number(input.misses) || 0),
      atMs: Math.round(Number(input.atMs) || 0),
    },
  });
}

async function botSnapshotFor(
  game: GameRow,
  players: GameView["players"],
): Promise<{ score: number; state: StoredBotState } | null> {
  if (!game.started_at || !game.bot_outcome) return null;
  const humanSeat = players.find((player) => player.is_bot !== 1);
  const elapsed = Math.min(Date.now() - new Date(game.started_at).getTime(), game.duration_ms);
  const state = parseBotState(game.bot_state);
  const restoreMs = state && state.atMs <= elapsed ? state.atMs : 0;

  const bot = resumeBot(game, state && state.atMs <= elapsed ? state : null);
  const steps = Math.max(1, Math.ceil((elapsed - restoreMs) / 250));
  const stepMs = (elapsed - restoreMs) / steps;
  for (let index = 1; index <= steps; index += 1) {
    bot.update(Math.round(restoreMs + stepMs * index), humanSeat?.score ?? 0);
  }
  const snapshot = bot.snapshot();
  return {
    score: snapshot.score,
    state: { ...bot.exportState(), atMs: elapsed },
  };
}

interface StoredBotState extends BotState {
  atMs: number;
}

function parseBotState(raw: string | null): StoredBotState | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredBotState;
  } catch {
    return null;
  }
}

function resumeBot(game: GameRow, state: StoredBotState | null): PulseBot {
  const bot = new PulseBot(
    game.seed,
    DEFAULT_BOT,
    (game.bot_outcome ?? "bot") as BotOutcome,
    game.duration_ms,
  );
  if (state) bot.restoreState(state);
  return bot;
}

async function persistBotState(
  game: GameRow,
  snapshot: StoredBotState,
): Promise<void> {
  const database = await db();
  await updateGame(database, game.id, { bot_state: JSON.stringify(snapshot) });
}

export async function startMatch(input: { gameId: string; userId: string }): Promise<GameRow> {
  const database = await db();
  const game = await findGameById(database, input.gameId);
  if (!game) throw new ChainDuelError("That duel does not exist.", "not_found", 404);
  const players = await listGamePlayers(database, game.id);
  if (!players.some((player) => player.user_id === input.userId)) {
    throw new ChainDuelError("You are not part of this duel.", "forbidden", 403);
  }
  if (game.status === "active" || game.status === "finished" || game.status === "settled") return game;
  if (game.status !== "joined") {
    throw new ChainDuelError("Both players must be in escrow before the duel starts.", "not_ready");
  }
  if (!game.demo && game.escrow_state !== "onchain") {
    throw new ChainDuelError("Escrow is not funded for this duel.", "not_funded");
  }
  if (game.mode === "bot" && !game.bot_outcome) {
    // Settlement randomness is drawn once, on the server, and never exposed.
    await updateGame(database, game.id, { bot_outcome: drawBotOutcome(DEFAULT_BOT) });
  }

  const claimed = await transitionGame(database, game.id, ["joined"], "active", {
    started_at: nowIso(),
  });
  if (!claimed) {
    const fresh = await findGameById(database, game.id);
    return fresh ?? game;
  }
  if (!game.demo && game.contract_game_id) {
    try {
      const txHash = await beginOnChainGame(game);
      if (txHash) await updateGame(database, game.id, { create_tx_hash: game.create_tx_hash ?? txHash });
    } catch (error) {
      await updateGame(database, game.id, { status: "joined", started_at: null });
      throw new ChainDuelError(`Could not start the duel on chain: ${messageOf(error)}`, "chain_error", 502);
    }
  }
  const fresh = await findGameById(database, game.id);
  if (!fresh) throw new ChainDuelError("Duel disappeared", "not_found", 404);
  await appendGameEvent(database, {
    gameId: fresh.id,
    seq: 0,
    type: "match_started",
    seat: null,
    payload: { seed: fresh.seed, durationMs: fresh.duration_ms },
  });
  return fresh;
}

export interface SubmitResultOutcome {
  game: GameRow;
  score: number;
  settled: boolean;
  waitingForOpponent: boolean;
}

export async function submitResult(input: {
  gameId: string;
  userId: string;
  payload: Omit<SubmissionPayload, "matchId">;
}): Promise<SubmitResultOutcome> {
  const database = await db();
  const game = await findGameById(database, input.gameId);
  if (!game) throw new ChainDuelError("That duel does not exist.", "not_found", 404);
  if (game.status === "settled" || game.status === "finished") {
    throw new ChainDuelError("That duel is already settled.", "already_settled");
  }
  if (game.status !== "active") {
    throw new ChainDuelError("That duel is not running.", "not_active");
  }
  const player = await findGamePlayer(database, game.id, input.userId);
  if (!player) throw new ChainDuelError("You are not part of this duel.", "forbidden", 403);

  const verification = verifySubmission(
    { ...input.payload, matchId: game.id },
    { seed: game.seed, durationMs: game.duration_ms },
  );
  if (!verification.valid) {
    await appendGameEvent(database, {
      gameId: game.id,
      seq: Date.now() % 1_000_000,
      type: "submission_rejected",
      seat: player.seat,
      payload: { errors: verification.errors },
    });
    throw new ChainDuelError(
      `We could not verify that result (${verification.errors.join(", ")}).`,
      "verification_failed",
      422,
    );
  }

  await recordPlayerResult(database, game.id, input.userId, {
    score: verification.score.score,
    maxCombo: verification.score.maxCombo,
    hits: verification.score.hits,
    misses: verification.score.misses,
    result: "finished",
  });

  const players = await listGamePlayers(database, game.id);
  const humanPlayers = players.filter((entry) => entry.is_bot !== 1);
  const allFinished = humanPlayers.every((entry) => entry.result === "finished");

  if (game.mode === "bot") {
    const settled = await finalizeBotMatch(game);
    return { game: settled, score: verification.score.score, settled: true, waitingForOpponent: false };
  }

  if (!allFinished) {
    return { game, score: verification.score.score, settled: false, waitingForOpponent: true };
  }

  const settled = await settleMatch(game.id);
  return { game: settled, score: verification.score.score, settled: true, waitingForOpponent: false };
}

async function finalizeBotMatch(game: GameRow): Promise<GameRow> {
  const database = await db();
  const players = await listGamePlayers(database, game.id);
  const human = players.find((player) => player.is_bot !== 1);
  if (!human) throw new ChainDuelError("Bot duel has no human player.", "invalid_state");

  const bot = resumeBot(game, parseBotState(game.bot_state));
  bot.update(game.duration_ms, human.score);
  const snapshot = bot.snapshot();

  await recordPlayerResult(database, game.id, botSeatId(), {
    score: snapshot.score,
    maxCombo: snapshot.maxCombo,
    hits: snapshot.hits,
    misses: snapshot.misses,
    result: "finished",
  });
  await updateGame(database, game.id, { bot_state: JSON.stringify({ ...bot.exportState(), atMs: game.duration_ms }) });
  return settleMatch(game.id);
}

function winnerOf(
  game: GameRow,
  players: GamePlayerRow[],
): { winner: GamePlayerRow; loser: GamePlayerRow | null; reason: string } {
  const sorted = [...players].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.max_combo !== a.max_combo) return b.max_combo - a.max_combo;
    return a.seat - b.seat;
  });
  const winner = sorted[0];
  const loser = sorted[1] ?? null;
  const tied = loser && loser.score === winner.score && loser.max_combo === winner.max_combo;
  return { winner, loser, reason: tied ? "tie_break_combo" : "higher_score" };
}

/**
 * Idempotent settlement. The `settlement_status` compare-and-set guarantees
 * exactly one caller can move the match into settlement, so a double submit or
 * a retry can never pay out twice.
 */
export async function settleMatch(gameId: string): Promise<GameRow> {
  const database = await db();
  const game = await findGameById(database, gameId);
  if (!game) throw new ChainDuelError("That duel does not exist.", "not_found", 404);
  if (game.status === "settled") return game;
  if (game.status === "cancelled" || game.status === "expired") return game;

  const players = await listGamePlayers(database, game.id);
  if (players.length < 2) {
    throw new ChainDuelError("That duel does not have two players.", "invalid_state");
  }

  const claimed = await database.run(
    `UPDATE games SET settlement_status = 'submitting', status = 'finished'
     WHERE id = ? AND (settlement_status IS NULL OR settlement_status = 'failed')`,
    [game.id],
  );
  if (claimed === 0) {
    const fresh = await findGameById(database, game.id);
    return fresh ?? game;
  }

  const { winner, reason } = winnerOf(game, players);
  const pool = game.entry_stroops * 2;
  const { payout, fee } = splitPool(pool, game.fee_bps);
  const winnerIsBot = winner.is_bot === 1;
  const resultHash = resultHashFor(game, players);

  const winnerWallet = winnerIsBot
    ? null
    : await primaryWallet(database, winner.user_id);
  const winnerAddress = winnerWallet?.address ?? null;

  // A previous attempt may have already paid out on chain. The hash is stored
  // before any local bookkeeping, so a retry only has to finish the books.
  let settlementTxHash: string | null = game.settle_tx_hash ?? null;
  if (!game.demo && game.contract_game_id && !settlementTxHash) {
    const contract = await import("../stellar/contract");
    const treasury = await contract.getOnChainConfig();
    const payoutAddress = winnerIsBot ? treasury?.treasury ?? null : winnerAddress;
    if (!payoutAddress) {
      await updateGame(database, game.id, { status: "active", settlement_status: "failed" });
      throw new ChainDuelError("Winner wallet could not be resolved.", "settlement_failed", 500);
    }
    try {
      const outcome = await settleOnChain({
        game,
        winnerAddress: payoutAddress,
        playerOneScore: players.find((player) => player.seat === 1)?.score ?? 0,
        playerTwoScore: players.find((player) => player.seat === 2)?.score ?? 0,
        resultHashHex: resultHash,
      });
      settlementTxHash = outcome.txHash;
      if (settlementTxHash) await updateGame(database, game.id, { settle_tx_hash: settlementTxHash });
    } catch (error) {
      await updateGame(database, game.id, { status: "active", settlement_status: "failed" });
      throw new ChainDuelError(`Settlement failed: ${messageOf(error)}`, "settlement_failed", 502);
    }
  }

  try {
    // Statistics, ratings, reputation, ledger rows and the final game status
    // are written atomically so a partial failure can never leave the match
    // half-settled: it rolls back and the retry path completes it.
    await database.transaction(async (tx) => {
      await applySettlement(tx, {
        game,
        players,
        winner,
        reason,
        payout,
        fee,
        settlementTxHash,
        demo: Boolean(game.demo),
      });
    });
  } catch (error) {
    await updateGame(database, game.id, { status: "finished", settlement_status: "failed" });
    throw new ChainDuelError(
      `Settlement could not be recorded: ${messageOf(error)}`,
      "settlement_failed",
      502,
    );
  }
  const fresh = await findGameById(database, game.id);
  if (!fresh) throw new ChainDuelError("Duel disappeared", "not_found", 404);
  return fresh;
}

function resultHashFor(game: GameRow, players: GamePlayerRow[]): string {
  const payload = [
    game.id,
    game.seed,
    ...players
      .slice()
      .sort((a, b) => a.seat - b.seat)
      .map((player) => `${player.seat}:${player.user_id}:${player.score}`),
  ].join("|");
  const bytes = new Uint8Array(32);
  const encoded = new TextEncoder().encode(payload);
  for (let index = 0; index < encoded.length; index += 1) {
    bytes[index % 32] = (bytes[index % 32] ^ encoded[index]) & 0xff;
  }
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function applySettlement(database: SqlDriver, input: {
  game: GameRow;
  players: GamePlayerRow[];
  winner: GamePlayerRow;
  reason: string;
  payout: number;
  fee: number;
  settlementTxHash: string | null;
  demo: boolean;
}): Promise<void> {
  const { game, players, winner, reason, payout, fee, settlementTxHash, demo } = input;
  const isBotMatch = game.mode === "bot";
  const rated = !demo && !isBotMatch;

  const profiles = new Map<string, Awaited<ReturnType<typeof findProfile>>>();
  for (const player of players) {
    if (player.is_bot === 1) continue;
    profiles.set(player.user_id, await findProfile(database, player.user_id));
  }

  let ratingDeltaForWinner = 0;
  let ratingDeltaForLoser = 0;
  const humanPlayers = players.filter((player) => player.is_bot !== 1);
  if (rated && humanPlayers.length === 2) {
    const [first, second] = humanPlayers;
    const profileA = profiles.get(first.user_id);
    const profileB = profiles.get(second.user_id);
    if (profileA && profileB) {
      const aWon = winner.user_id === first.user_id;
      const outcome = applyElo(profileA.rating, profileB.rating, aWon ? 1 : 0);
      const firstDelta = aWon ? outcome.deltaA : outcome.deltaB;
      const secondDelta = aWon ? outcome.deltaB : outcome.deltaA;
      const firstAfter = Math.max(100, profileA.rating + firstDelta);
      const secondAfter = Math.max(100, profileB.rating + secondDelta);
      await updateProfile(database, first.user_id, { rating: firstAfter });
      await updateProfile(database, second.user_id, { rating: secondAfter });
      await recordRating(database, {
        userId: first.user_id,
        gameId: game.id,
        before: profileA.rating,
        after: firstAfter,
        delta: firstDelta,
        mode: "human",
      });
      await recordRating(database, {
        userId: second.user_id,
        gameId: game.id,
        before: profileB.rating,
        after: secondAfter,
        delta: secondDelta,
        mode: "human",
      });
      ratingDeltaForWinner = aWon ? firstDelta : secondDelta;
      ratingDeltaForLoser = aWon ? secondDelta : firstDelta;
    }
  }

  for (const player of humanPlayers) {
    const profile = profiles.get(player.user_id);
    if (!profile) continue;
    const won = winner.user_id === player.user_id;
    const opponent = players.find((entry) => entry.user_id !== player.user_id) ?? null;
    const opponentProfile = opponent && opponent.is_bot !== 1 ? profiles.get(opponent.user_id) : null;
    const opponentLabel = opponent?.is_bot === 1 ? DEFAULT_BOT.name : opponentProfile?.username ?? "Player";
    const reward = won ? payout : 0;
    const ratingDelta = won ? ratingDeltaForWinner : ratingDeltaForLoser;

    if (!demo) {
      const ratingValue = rated ? profile.rating + ratingDelta : profile.rating;
      const streak = won ? profile.current_streak + 1 : 0;
      const reputationDelta = REPUTATION.completedMatch;
      await updateProfile(database, player.user_id, {
        wins: profile.wins + (won ? 1 : 0),
        losses: profile.losses + (won ? 0 : 1),
        games_played: profile.games_played + 1,
        human_games: profile.human_games + (isBotMatch ? 0 : 1),
        bot_games: profile.bot_games + (isBotMatch ? 1 : 0),
        bot_wins: profile.bot_wins + (isBotMatch && won ? 1 : 0),
        bot_losses: profile.bot_losses + (isBotMatch && !won ? 1 : 0),
        current_streak: streak,
        best_streak: Math.max(profile.best_streak, streak),
        total_earned_stroops: profile.total_earned_stroops + reward,
        total_wagered_stroops: profile.total_wagered_stroops + game.entry_stroops,
        fees_paid_stroops: profile.fees_paid_stroops + (isBotMatch ? 0 : fee / 2),
        reputation: Math.min(REPUTATION.max, Math.max(REPUTATION.min, profile.reputation + reputationDelta)),
        rating: ratingValue,
      });
      await recordReputation(database, {
        userId: player.user_id,
        gameId: game.id,
        delta: reputationDelta,
        reason: "match_completed",
      });
      void ratingDelta;
    }

    await upsertMatch(database, {
      gameId: game.id,
      userId: player.user_id,
      opponentId: opponent?.is_bot === 1 ? null : opponent?.user_id ?? null,
      opponentLabel,
      mode: game.mode,
      result: won ? "win" : "loss",
      scoreFor: player.score,
      scoreAgainst: opponent?.score ?? 0,
      entryStroops: game.entry_stroops,
      rewardStroops: reward,
      ratingDelta,
      settlementTxHash,
      demo,
    });

    if (reward > 0) {
      await createTransaction(database, {
        userId: player.user_id,
        gameId: game.id,
        kind: isBotMatch ? "bot_settlement" : "payout",
        direction: "in",
        amountStroops: reward,
        status: "confirmed",
        txHash: settlementTxHash,
        explorerUrl: settlementTxHash ? explorerTxUrl(settlementTxHash) : null,
        address: (await primaryWallet(database, player.user_id))?.address ?? null,
        demo,
        metadata: { role: "winner", reason },
      });
    }
    if (fee > 0) {
      await createTransaction(database, {
        userId: player.user_id,
        gameId: game.id,
        kind: "fee",
        direction: "out",
        amountStroops: 0,
        status: "confirmed",
        txHash: settlementTxHash,
        explorerUrl: settlementTxHash ? explorerTxUrl(settlementTxHash) : null,
        demo,
        metadata: { note: "Protocol fee is deducted from the prize pool", feeStroops: fee },
      });
    }

    if (isBotMatch && !demo) {
      // Net protocol result for the match, excluding the protocol fee (which is
      // recorded as its own ledger line): a player win costs the treasury its
      // bot stake (-entry); a bot win returns the stake plus the player's entry
      // minus the fee. `treasuryDelta + fee` therefore equals the exact change
      // in protocol-owned value on chain (bot liquidity + accrued fees +
      // treasury wallet balance).
      const treasuryDelta = won ? -game.entry_stroops : game.entry_stroops - fee;
      await recordBotMatch(database, {
        game_id: game.id,
        player_id: player.user_id,
        bot_id: DEFAULT_BOT.id,
        entry_stroops: game.entry_stroops,
        bot_stake_stroops: game.entry_stroops,
        player_score: player.user_id === winner.user_id ? player.score : opponent?.score ?? 0,
        bot_score: opponent?.score ?? 0,
        winner: won ? "player" : "bot",
        fee_stroops: fee,
        player_reward_stroops: reward,
        treasury_delta_stroops: treasuryDelta,
        settlement_tx_hash: settlementTxHash,
        created_at: nowIso(),
      });
      await recordBotTreasuryMovement(
        {
          kind: "bot_settlement",
          direction: treasuryDelta >= 0 ? "in" : "out",
          amountStroops: Math.abs(treasuryDelta),
          txHash: settlementTxHash,
          gameId: game.id,
          metadata: { winner: won ? "player" : "bot" },
        },
        database,
      );
      await recordBotTreasuryMovement(
        {
          kind: "fee_accrual",
          direction: "in",
          amountStroops: fee,
          txHash: settlementTxHash,
          gameId: game.id,
          metadata: { note: "Protocol fee retained by the contract" },
        },
        database,
      );
    }

    if (!demo && profile) {
      const unlocked = evaluateAchievements({
        gamesPlayed: profile.games_played + 1,
        wins: profile.wins + (won ? 1 : 0),
        streak: won ? profile.current_streak + 1 : 0,
        rating: profile.rating + ratingDelta,
        maxCombo: player.max_combo,
        bestMultiplier: 1,
        score: player.score,
        opponentLabel,
        won,
      });
      for (const code of unlocked) {
        await unlockAchievement(database, player.user_id, code);
      }
    }
  }

  await updateGame(database, game.id, {
    status: "settled",
    winner_id: winner.is_bot === 1 ? null : winner.user_id,
    player_one_score: players.find((player) => player.seat === 1)?.score ?? 0,
    player_two_score: players.find((player) => player.seat === 2)?.score ?? 0,
    payout_stroops: payout,
    fee_stroops: fee,
    pool_stroops: game.entry_stroops * 2,
    result_hash: resultHashFor(game, players),
    settlement_status: "confirmed",
    settled_at: nowIso(),
    finished_at: nowIso(),
    escrow_state: demo ? "offchain" : "settled",
  });

  // The duel is over: release any matchmaking ticket that pointed at it so the
  // players can queue for a fresh match instead of being sent back here.
  await completeQueueEntriesForGame(database, game.id);
}

export async function gameDurationMs(game: GameRow): Promise<number> {
  return game.duration_ms || PULSE_DUEL.durationMs;
}

export async function scheduleFor(game: GameRow) {
  return buildTargetSchedule(game.seed, game.duration_ms);
}

export async function maxScoreFor(game: GameRow): Promise<number> {
  return theoreticalMaxScore(scheduleFor(game) as never);
}

export async function botWinProbability(): Promise<number> {
  const database = await db();
  const stored = await getSetting(database, "bot.win_probability");
  const parsed = stored ? Number(stored) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed < 1 ? parsed : DEFAULT_BOT.winProbability;
}

export async function botThresholds() {
  const database = await db();
  return {
    entryXlm: stroopsToXlm(Number((await getSetting(database, "treasury.max_bot_entry")) ?? 0)),
  };
}

export async function addBotPlayer(gameId: string): Promise<void> {
  const database = await db();
  const existing = await findGamePlayer(database, gameId, botSeatId());
  if (existing) return;
  await addGamePlayer(database, { gameId, userId: botSeatId(), seat: 2, isBot: true });
}

export async function ensureSettlementForExpiredMatches(limit = 10): Promise<number> {
  const database = await db();
  const stale = await database.query<GameRow>(
    `SELECT * FROM games WHERE status = 'active' AND started_at IS NOT NULL
     ORDER BY started_at ASC LIMIT ?`,
    [limit],
  );
  let settled = 0;
  for (const game of stale) {
    if (!game.started_at) continue;
    const elapsed = Date.now() - new Date(game.started_at).getTime();
    if (elapsed < game.duration_ms + 20_000) continue;
    try {
      await settleMatch(game.id);
      settled += 1;
    } catch {
      // leave for the next sweep
    }
  }
  return settled;
}
