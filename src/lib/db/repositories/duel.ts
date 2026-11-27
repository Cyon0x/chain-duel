import { newId, nowIso } from "../index";
import { stellarNetwork, tokenContractId, publicStellarConfig } from "../../config/stellar";
import { stellarVerificationEnabled } from "../../config/stellar-verification";
import { STELLAR_TESTNET_USDC } from "../../stellar/shared";
import type { StellarAssetSymbol, StellarNetworkId } from "../../stellar/shared";
import type {
  BotMatchRow,
  GameEventRow,
  GameMode,
  GamePlayerRow,
  GameRow,
  GameStatus,
  InviteRow,
  MatchRow,
  QueueRow,
  SqlDriver,
} from "../types";

const GAME_FIELDS = [
  "status",
  "opponent_id",
  "winner_id",
  "pool_stroops",
  "payout_stroops",
  "fee_stroops",
  "protocol_fee_stroops",
  "ecosystem_fee_stroops",
  "start_tx_hash",
  "settlement_started_at",
  "seed",
  "seed_chain_verified",
  "input_deadline_ms",
  "player_one_score",
  "player_two_score",
  "escrow_state",
  "settlement_status",
  "contract_game_id",
  "result_hash",
  "create_tx_hash",
  "join_tx_hash",
  "settle_tx_hash",
  "started_at",
  "finished_at",
  "settled_at",
  "expires_at",
  "bot_outcome",
  "bot_state",
] as const;

// -------------------------------------------------------------------- games

export async function createGame(
  db: SqlDriver,
  input: {
    id?: string;
    code: string;
    mode: GameMode;
    visibility: string;
    creatorId: string;
    entryStroops: number;
    feeBps: number;
    seed: string;
    durationMs: number;
    expiresAt: string;
    escrowState: string;
    demo: boolean;
    contractGameId?: string | null;
    escrowContractId?: string | null;
    stellarNetwork?: StellarNetworkId;
    currency?: StellarAssetSymbol;
    tokenContractId?: string;
    verificationVersion?: number;
  },
): Promise<GameRow> {
  const id = input.id ?? newId("gam");
  const network = input.stellarNetwork ?? stellarNetwork().id;
  const token = input.tokenContractId ?? tokenContractId(network);
  const currency = input.currency ?? (network === "mainnet" || token === STELLAR_TESTNET_USDC ? "USDC" : "XLM");
  const verificationVersion = input.verificationVersion ?? (!input.demo && stellarVerificationEnabled(network) ? 1 : 0);
  const protocolBps = network === "mainnet" || verificationVersion === 1 ? Math.floor(input.feeBps / 2) : input.feeBps;
  const insert = async (target: SqlDriver): Promise<GameRow> => {
    await target.execute(
      `INSERT INTO games (id, code, game_type, mode, status, visibility, creator_id, entry_stroops, pool_stroops,
         fee_bps, seed, duration_ms, escrow_state, demo, created_at, expires_at, contract_game_id,
         stellar_network,currency,token_contract_id,protocol_fee_bps,ecosystem_fee_bps,verification_version)
       VALUES (?, ?, 'pulse_duel', ?, 'waiting', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.code,
        input.mode,
        input.visibility,
        input.creatorId,
        input.entryStroops,
        input.escrowState === "onchain" ? input.entryStroops : 0,
        input.feeBps,
        input.seed,
        input.durationMs,
        input.escrowState,
        input.demo ? 1 : 0,
        nowIso(),
        input.expiresAt,
        input.contractGameId ?? null,
        network,
        currency,
        token,
        protocolBps,
        input.feeBps - protocolBps,
        verificationVersion,
      ],
    );
    if (input.escrowContractId) {
      await target.execute("INSERT INTO game_escrow_contracts (game_id, contract_id) VALUES (?, ?)", [id, input.escrowContractId]);
    }
    const game = await findGameById(target, id);
    if (!game) throw new Error("Failed to create game");
    return game;
  };
  // A failed binding must not leave a new game looking like a legacy duel.
  return input.escrowContractId ? db.transaction(insert) : insert(db);
}

export async function findGameById(db: SqlDriver, id: string): Promise<GameRow | null> {
  return db.one<GameRow>("SELECT * FROM games WHERE id = ?", [id]);
}

export async function findGameEscrowContract(db: SqlDriver, gameId: string): Promise<string | null> {
  const row = await db.one<{ contract_id: string }>("SELECT contract_id FROM game_escrow_contracts WHERE game_id = ?", [gameId]);
  return row?.contract_id ?? null;
}

export async function findGameByCode(db: SqlDriver, code: string): Promise<GameRow | null> {
  return db.one<GameRow>("SELECT * FROM games WHERE code = ?", [code.toUpperCase()]);
}

export async function findGameByContractId(
  db: SqlDriver,
  contractGameId: string,
): Promise<GameRow | null> {
  return db.one<GameRow>("SELECT * FROM games WHERE contract_game_id = ?", [contractGameId]);
}

export async function updateGame(
  db: SqlDriver,
  id: string,
  patch: Partial<Record<(typeof GAME_FIELDS)[number], unknown>>,
): Promise<void> {
  const entries = GAME_FIELDS.filter((field) => patch[field] !== undefined).map((field) => [
    field,
    patch[field],
  ]) as Array<[string, unknown]>;
  if (entries.length === 0) return;
  const assignments = entries.map(([field]) => `${field} = ?`).join(", ");
  await db.execute(`UPDATE games SET ${assignments} WHERE id = ?`, [
    ...entries.map(([, value]) => value),
    id,
  ]);
}

/** Compare-and-set game status. Returns true when this caller performed the transition. */
export async function transitionGame(
  db: SqlDriver,
  id: string,
  from: GameStatus[],
  to: GameStatus,
  patch: Record<string, unknown> = {},
): Promise<boolean> {
  const placeholders = from.map(() => "?").join(", ");
  const extra = Object.keys(patch);
  const assignments = extra.length
    ? `, ${extra.map((key) => `${key} = ?`).join(", ")}`
    : "";
  const affected = await db.run(
    `UPDATE games SET status = ?${assignments} WHERE id = ? AND status IN (${placeholders})`,
    [to, ...extra.map((key) => patch[key]), id, ...from],
  );
  return affected > 0;
}

export async function listRecentGamesForUser(
  db: SqlDriver,
  userId: string,
  limit = 8,
): Promise<GameRow[]> {
  return db.query<GameRow>(
    `SELECT * FROM games
     WHERE (creator_id = ? OR opponent_id = ?) AND status IN ('settled','finished','cancelled','expired')
     ORDER BY created_at DESC LIMIT ?`,
    [userId, userId, limit],
  );
}

export async function listActiveGamesForUser(db: SqlDriver, userId: string): Promise<GameRow[]> {
  return db.query<GameRow>(
    `SELECT * FROM games
     WHERE (creator_id = ? OR opponent_id = ?) AND status IN ('waiting','joined','active')
     ORDER BY created_at DESC`,
    [userId, userId],
  );
}

export async function countGamesForUser(db: SqlDriver, userId: string): Promise<number> {
  const row = await db.one<{ count: number }>(
    "SELECT COUNT(*) AS count FROM games WHERE creator_id = ? OR opponent_id = ?",
    [userId, userId],
  );
  return Number(row?.count ?? 0);
}

export async function listGamesNeedingSettlement(db: SqlDriver, limit = 25): Promise<GameRow[]> {
  return db.query<GameRow>(
    `SELECT * FROM games
     WHERE status IN ('joined','active','finished') AND demo = 0 AND escrow_state = 'onchain'
     ORDER BY created_at ASC LIMIT ?`,
    [limit],
  );
}

export async function listOpenPublicGames(db: SqlDriver, limit = 20): Promise<GameRow[]> {
  return db.query<GameRow>(
    `SELECT * FROM games WHERE status = 'waiting' AND visibility = 'public' AND mode = 'pvp'
     ORDER BY created_at DESC LIMIT ?`,
    [limit],
  );
}

export async function staleWaitingGames(db: SqlDriver, beforeIso: string): Promise<GameRow[]> {
  return db.query<GameRow>(
    `SELECT * FROM games WHERE status IN ('waiting','joined') AND expires_at < ? LIMIT 50`,
    [beforeIso],
  );
}

// ------------------------------------------------------------ game players

export async function addGamePlayer(
  db: SqlDriver,
  input: {
    gameId: string;
    userId: string;
    seat: number;
    address?: string | null;
    isBot?: boolean;
  },
): Promise<GamePlayerRow> {
  const id = newId("gpl");
  await db.execute(
    `INSERT INTO game_players (id, game_id, user_id, seat, address, is_bot, joined_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, input.gameId, input.userId, input.seat, input.address ?? null, input.isBot ? 1 : 0, nowIso()],
  );
  const row = await db.one<GamePlayerRow>("SELECT * FROM game_players WHERE id = ?", [id]);
  if (!row) throw new Error("Failed to add game player");
  return row;
}

export async function listGamePlayers(db: SqlDriver, gameId: string): Promise<GamePlayerRow[]> {
  return db.query<GamePlayerRow>(
    "SELECT * FROM game_players WHERE game_id = ? ORDER BY seat ASC",
    [gameId],
  );
}

export async function removeGamePlayer(db: SqlDriver, gameId: string, userId: string): Promise<void> {
  await db.execute("DELETE FROM game_players WHERE game_id = ? AND user_id = ?", [gameId, userId]);
}

export async function findGamePlayer(
  db: SqlDriver,
  gameId: string,
  userId: string,
): Promise<GamePlayerRow | null> {
  return db.one<GamePlayerRow>(
    "SELECT * FROM game_players WHERE game_id = ? AND user_id = ?",
    [gameId, userId],
  );
}

export async function recordPlayerResult(
  db: SqlDriver,
  gameId: string,
  userId: string,
  input: { score: number; maxCombo: number; hits: number; misses: number; result: string },
): Promise<void> {
  await db.execute(
    `UPDATE game_players SET score = ?, max_combo = ?, hits = ?, misses = ?, result = ?
     WHERE game_id = ? AND user_id = ?`,
    [input.score, input.maxCombo, input.hits, input.misses, input.result, gameId, userId],
  );
}

// ------------------------------------------------------------- game events

export async function appendGameEvent(
  db: SqlDriver,
  input: { gameId: string; seq: number; type: string; seat?: number | null; payload: unknown },
): Promise<void> {
  await db.execute(
    "INSERT INTO game_events (game_id, seq, type, seat, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [input.gameId, input.seq, input.type, input.seat ?? null, JSON.stringify(input.payload), nowIso()],
  );
}

export async function listGameEvents(db: SqlDriver, gameId: string): Promise<GameEventRow[]> {
  return db.query<GameEventRow>(
    "SELECT * FROM game_events WHERE game_id = ? ORDER BY seq ASC",
    [gameId],
  );
}

// ------------------------------------------------------------------ invites

export async function createInvite(
  db: SqlDriver,
  input: {
    code: string;
    gameId: string;
    creatorId: string;
    invitedUserId?: string | null;
    channel: "link" | "direct";
    entryStroops: number;
    expiresAt: string;
  },
): Promise<InviteRow> {
  const id = newId("inv");
  await db.execute(
    `INSERT INTO invites (id, code, game_id, creator_id, invited_user_id, channel, status, entry_stroops, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.code,
      input.gameId,
      input.creatorId,
      input.invitedUserId ?? null,
      input.channel,
      input.invitedUserId ? "pending" : "created",
      input.entryStroops,
      nowIso(),
      input.expiresAt,
    ],
  );
  const invite = await db.one<InviteRow>("SELECT * FROM invites WHERE id = ?", [id]);
  if (!invite) throw new Error("Failed to create invite");
  return invite;
}

export async function findInviteByCode(db: SqlDriver, code: string): Promise<InviteRow | null> {
  return db.one<InviteRow>("SELECT * FROM invites WHERE code = ?", [code.toUpperCase()]);
}

export async function findInviteByGame(db: SqlDriver, gameId: string): Promise<InviteRow | null> {
  return db.one<InviteRow>(
    "SELECT * FROM invites WHERE game_id = ? ORDER BY created_at DESC LIMIT 1",
    [gameId],
  );
}

export async function listInvitesForUser(
  db: SqlDriver,
  userId: string,
  statuses: string[] = ["pending"],
): Promise<InviteRow[]> {
  const placeholders = statuses.map(() => "?").join(", ");
  return db.query<InviteRow>(
    `SELECT i.* FROM invites i
     WHERE i.invited_user_id = ? AND i.status IN (${placeholders}) AND i.expires_at > ?
     ORDER BY i.created_at DESC LIMIT 25`,
    [userId, ...statuses, nowIso()],
  );
}

export async function updateInviteStatus(
  db: SqlDriver,
  id: string,
  status: string,
  acceptedBy?: string | null,
): Promise<boolean> {
  const affected = await db.run(
    "UPDATE invites SET status = ?, responded_at = ?, accepted_by = COALESCE(?, accepted_by) WHERE id = ? AND status IN ('created','pending')",
    [status, nowIso(), acceptedBy ?? null, id],
  );
  return affected > 0;
}

/** Releases a tentative accept when the escrow that followed it failed. */
export async function revertInviteClaim(db: SqlDriver, id: string, acceptedBy: string): Promise<boolean> {
  const affected = await db.run(
    "UPDATE invites SET status = 'pending', responded_at = NULL, accepted_by = NULL WHERE id = ? AND status = 'accepted' AND accepted_by = ?",
    [id, acceptedBy],
  );
  return affected > 0;
}

export async function expireInvites(db: SqlDriver, beforeIso: string): Promise<number> {
  return db.run(
    "UPDATE invites SET status = 'expired', responded_at = ? WHERE status IN ('created','pending') AND expires_at < ?",
    [nowIso(), beforeIso],
  );
}

// -------------------------------------------------------- matchmaking queue

export async function enqueue(
  db: SqlDriver,
  input: {
    userId: string;
    gameType: string;
    entryStroops: number;
    demo: boolean;
    expiresAt: string;
    stellarNetwork?: StellarNetworkId;
    currency?: StellarAssetSymbol;
  },
): Promise<QueueRow> {
  const id = newId("que");
  const timestamp = nowIso();
  await db.execute(
    `INSERT INTO matchmaking_queue (id, user_id, game_type, entry_stroops, demo, status, created_at, updated_at, expires_at,stellar_network,currency)
     VALUES (?, ?, ?, ?, ?, 'searching', ?, ?, ?, ?, ?)`,
    [id, input.userId, input.gameType, input.entryStroops, input.demo ? 1 : 0, timestamp, timestamp, input.expiresAt, input.stellarNetwork ?? stellarNetwork().id, input.currency ?? publicStellarConfig().asset.symbol],
  );
  const row = await db.one<QueueRow>("SELECT * FROM matchmaking_queue WHERE id = ?", [id]);
  if (!row) throw new Error("Failed to enqueue");
  return row;
}

export async function findActiveQueueEntry(
  db: SqlDriver,
  userId: string,
  network: StellarNetworkId = stellarNetwork().id,
): Promise<QueueRow | null> {
  return db.one<QueueRow>(
    `SELECT * FROM matchmaking_queue WHERE user_id = ? AND stellar_network = ? AND currency = ? AND status IN ('searching','matched')
     ORDER BY created_at DESC LIMIT 1`,
    [userId, network, publicStellarConfig().asset.symbol],
  );
}

export async function findQueueEntry(db: SqlDriver, id: string): Promise<QueueRow | null> {
  return db.one<QueueRow>("SELECT * FROM matchmaking_queue WHERE id = ?", [id]);
}

export async function findOpponentInQueue(
  db: SqlDriver,
  input: { userId: string; gameType: string; entryStroops: number; demo: boolean; stellarNetwork?: StellarNetworkId },
): Promise<QueueRow | null> {
  return db.one<QueueRow>(
    `SELECT * FROM matchmaking_queue
     WHERE status = 'searching' AND user_id != ? AND game_type = ? AND entry_stroops = ? AND demo = ?
       AND expires_at > ? AND stellar_network = ? AND currency = ?
     ORDER BY created_at ASC LIMIT 1`,
    [input.userId, input.gameType, input.entryStroops, input.demo ? 1 : 0, nowIso(), input.stellarNetwork ?? stellarNetwork().id, publicStellarConfig().asset.symbol],
  );
}

export async function claimQueueEntry(db: SqlDriver, id: string, gameId: string): Promise<boolean> {
  const affected = await db.run(
    "UPDATE matchmaking_queue SET status = 'matched', game_id = ?, updated_at = ? WHERE id = ? AND status = 'searching'",
    [gameId, nowIso(), id],
  );
  return affected > 0;
}

export async function closeQueueEntry(
  db: SqlDriver,
  id: string,
  status: "cancelled" | "completed" | "expired",
): Promise<boolean> {
  const affected = await db.run(
    "UPDATE matchmaking_queue SET status = ?, updated_at = ? WHERE id = ? AND status IN ('searching','matched')",
    [status, nowIso(), id],
  );
  return affected > 0;
}

/**
 * Releases every queue ticket pointing at a duel that is no longer playable.
 * Without this a finished match keeps its 'matched' ticket, so re-queueing
 * would hand the player the same finished duel back again.
 */
export async function completeQueueEntriesForGame(db: SqlDriver, gameId: string): Promise<number> {
  return db.run(
    "UPDATE matchmaking_queue SET status = 'completed', updated_at = ? WHERE game_id = ? AND status IN ('searching','matched')",
    [nowIso(), gameId],
  );
}

export async function expireQueueEntries(db: SqlDriver, beforeIso: string): Promise<number> {
  return db.run(
    "UPDATE matchmaking_queue SET status = 'expired', updated_at = ? WHERE status = 'searching' AND expires_at < ?",
    [nowIso(), beforeIso],
  );
}

// ------------------------------------------------------------------ matches

export async function upsertMatch(
  db: SqlDriver,
  input: {
    gameId: string;
    userId: string;
    opponentId: string | null;
    opponentLabel: string;
    mode: GameMode;
    result: string;
    scoreFor: number;
    scoreAgainst: number;
    entryStroops: number;
    rewardStroops: number;
    ratingDelta: number;
    settlementTxHash: string | null;
    demo: boolean;
    stellarNetwork?: StellarNetworkId;
    currency?: StellarAssetSymbol;
  },
): Promise<void> {
  const existing = await db.one<MatchRow>(
    "SELECT * FROM matches WHERE game_id = ? AND user_id = ?",
    [input.gameId, input.userId],
  );
  if (existing) return;
  await db.execute(
    `INSERT INTO matches (id, game_id, user_id, opponent_id, opponent_label, mode, result, score_for, score_against,
       entry_stroops, reward_stroops, rating_delta, settlement_tx_hash, demo, created_at,stellar_network,currency)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId("mat"),
      input.gameId,
      input.userId,
      input.opponentId,
      input.opponentLabel,
      input.mode,
      input.result,
      input.scoreFor,
      input.scoreAgainst,
      input.entryStroops,
      input.rewardStroops,
      input.ratingDelta,
      input.settlementTxHash,
      input.demo ? 1 : 0,
      nowIso(),
      input.stellarNetwork ?? stellarNetwork().id,
      input.currency ?? ((input.stellarNetwork ?? stellarNetwork().id) === "mainnet" ? "USDC" : "XLM"),
    ],
  );
}

export async function listMatchesForUser(
  db: SqlDriver,
  userId: string,
  options: { limit?: number; mode?: string } = {},
): Promise<MatchRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  if (options.mode) {
    return db.query<MatchRow>(
      "SELECT * FROM matches WHERE user_id = ? AND mode = ? ORDER BY created_at DESC LIMIT ?",
      [userId, options.mode, limit],
    );
  }
  return db.query<MatchRow>(
    "SELECT * FROM matches WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
    [userId, limit],
  );
}

export async function countMatchesForUser(db: SqlDriver, userId: string): Promise<number> {
  const row = await db.one<{ count: number }>(
    "SELECT COUNT(*) AS count FROM matches WHERE user_id = ?",
    [userId],
  );
  return Number(row?.count ?? 0);
}

// -------------------------------------------------------- rating/reputation

export async function recordRating(
  db: SqlDriver,
  input: {
    userId: string;
    gameId: string;
    before: number;
    after: number;
    delta: number;
    mode: string;
  },
): Promise<void> {
  await db.execute(
    `INSERT INTO ratings (id, user_id, game_id, rating_before, rating_after, delta, mode, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [newId("rat"), input.userId, input.gameId, input.before, input.after, input.delta, input.mode, nowIso()],
  );
}

export async function recordReputation(
  db: SqlDriver,
  input: { userId: string; gameId: string | null; delta: number; reason: string },
): Promise<void> {
  await db.execute(
    "INSERT INTO reputation (id, user_id, game_id, delta, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [newId("rep"), input.userId, input.gameId, input.delta, input.reason, nowIso()],
  );
}

// ------------------------------------------------------------- bot matches

export async function recordBotMatch(db: SqlDriver, row: BotMatchRow): Promise<void> {
  await db.execute(
    `INSERT INTO bot_matches (game_id, player_id, bot_id, entry_stroops, bot_stake_stroops, player_score, bot_score,
       winner, fee_stroops, player_reward_stroops, treasury_delta_stroops, settlement_tx_hash, created_at,stellar_network,currency)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.game_id,
      row.player_id,
      row.bot_id,
      row.entry_stroops,
      row.bot_stake_stroops,
      row.player_score,
      row.bot_score,
      row.winner,
      row.fee_stroops,
      row.player_reward_stroops,
      row.treasury_delta_stroops,
      row.settlement_tx_hash,
      row.created_at,
      row.stellar_network ?? stellarNetwork().id,
      row.currency ?? ((row.stellar_network ?? stellarNetwork().id) === "mainnet" ? "USDC" : "XLM"),
    ],
  );
}

export async function listBotMatches(db: SqlDriver, limit = 50, network: StellarNetworkId = stellarNetwork().id): Promise<BotMatchRow[]> {
  return db.query<BotMatchRow>(
    "SELECT * FROM bot_matches WHERE stellar_network = ? ORDER BY created_at DESC LIMIT ?",
    [network, limit],
  );
}

export async function botMatchTotals(db: SqlDriver, network: StellarNetworkId = stellarNetwork().id): Promise<{
  games: number;
  bot_wins: number;
  player_wins: number;
  player_rewards: number;
  treasury_delta: number;
  fees: number;
}> {
  const row = await db.one<{
    games: number;
    bot_wins: number;
    player_wins: number;
    player_rewards: number;
    treasury_delta: number;
    fees: number;
  }>(
    `SELECT COUNT(*) AS games,
            SUM(CASE WHEN winner = 'bot' THEN 1 ELSE 0 END) AS bot_wins,
            SUM(CASE WHEN winner = 'player' THEN 1 ELSE 0 END) AS player_wins,
            COALESCE(SUM(player_reward_stroops), 0) AS player_rewards,
            COALESCE(SUM(treasury_delta_stroops), 0) AS treasury_delta,
            COALESCE(SUM(fee_stroops), 0) AS fees
     FROM bot_matches WHERE stellar_network = ?`,
    [network],
  );
  return {
    games: Number(row?.games ?? 0),
    bot_wins: Number(row?.bot_wins ?? 0),
    player_wins: Number(row?.player_wins ?? 0),
    player_rewards: Number(row?.player_rewards ?? 0),
    treasury_delta: Number(row?.treasury_delta ?? 0),
    fees: Number(row?.fees ?? 0),
  };
}
