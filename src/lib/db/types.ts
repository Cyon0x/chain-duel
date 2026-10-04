export type SqlDialect = "sqlite" | "postgres";

export interface SqlDriver {
  readonly dialect: SqlDialect;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<void>;
  /** Executes a statement and returns the number of affected rows (for compare-and-set). */
  run(sql: string, params?: unknown[]): Promise<number>;
  transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type PersistenceMode = "postgres" | "sqlite-file" | "sqlite-memory" | "unavailable";

// --------------------------------------------------------------- identity

export type AuthProvider = "stellar" | "google" | "x" | "demo";
export type WalletCustody = "external" | "managed";

export interface UserRow {
  id: string;
  primary_wallet: string | null;
  email: string | null;
  auth_provider: AuthProvider;
  provider_account_id: string | null;
  status: string;
  is_admin: number;
  created_at: string;
  last_seen_at: string | null;
}

export interface ProfileRow {
  user_id: string;
  username: string;
  username_lower: string;
  avatar: string | null;
  theme: string;
  onboarding_complete: number;
  rating: number;
  reputation: number;
  wins: number;
  losses: number;
  games_played: number;
  human_games: number;
  bot_games: number;
  bot_wins: number;
  bot_losses: number;
  current_streak: number;
  best_streak: number;
  total_earned_stroops: number;
  total_wagered_stroops: number;
  fees_paid_stroops: number;
  achievements: string;
  created_at: string;
  updated_at: string;
}

export interface WalletRow {
  id: string;
  user_id: string;
  address: string;
  provider: string;
  custody: WalletCustody;
  is_primary: number;
  label: string | null;
  network: string;
  linked_at: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  wallet_address: string | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  user_agent_hash: string | null;
}

// ------------------------------------------------------------------ games

export type GameMode = "pvp" | "bot" | "private";
export type GameStatus =
  | "waiting"
  | "joined"
  | "active"
  | "finished"
  | "settled"
  | "cancelled"
  | "expired"
  | "refunded";

export type SettlementStatus = "pending" | "submitted" | "confirmed" | "failed";
export type EscrowState = "none" | "offchain" | "onchain" | "settled" | "refunded";

export interface GameRow {
  id: string;
  code: string;
  game_type: string;
  mode: GameMode;
  status: GameStatus;
  visibility: string;
  creator_id: string;
  opponent_id: string | null;
  winner_id: string | null;
  entry_stroops: number;
  pool_stroops: number;
  fee_bps: number;
  payout_stroops: number;
  fee_stroops: number;
  player_one_score: number;
  player_two_score: number;
  seed: string;
  duration_ms: number;
  escrow_state: EscrowState;
  settlement_status: SettlementStatus | null;
  contract_game_id: string | null;
  result_hash: string | null;
  create_tx_hash: string | null;
  join_tx_hash: string | null;
  settle_tx_hash: string | null;
  demo: number;
  bot_outcome: string | null;
  bot_state: string | null;
  created_at: string;
  expires_at: string;
  started_at: string | null;
  finished_at: string | null;
  settled_at: string | null;
}

export interface GamePlayerRow {
  id: string;
  game_id: string;
  user_id: string;
  seat: number;
  address: string | null;
  score: number;
  max_combo: number;
  hits: number;
  misses: number;
  is_bot: number;
  result: string | null;
  joined_at: string;
}

export interface GameEventRow {
  id: number;
  game_id: string;
  seq: number;
  type: string;
  seat: number | null;
  payload: string;
  created_at: string;
}

export interface InviteRow {
  id: string;
  code: string;
  game_id: string;
  creator_id: string;
  invited_user_id: string | null;
  channel: string;
  status: string;
  entry_stroops: number;
  created_at: string;
  expires_at: string;
  responded_at: string | null;
  accepted_by: string | null;
}

export interface QueueRow {
  id: string;
  user_id: string;
  game_type: string;
  entry_stroops: number;
  demo: number;
  status: string;
  game_id: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export interface MatchRow {
  id: string;
  game_id: string;
  user_id: string;
  opponent_id: string | null;
  opponent_label: string;
  mode: GameMode;
  result: string;
  score_for: number;
  score_against: number;
  entry_stroops: number;
  reward_stroops: number;
  rating_delta: number;
  settlement_tx_hash: string | null;
  demo: number;
  created_at: string;
}

export interface RatingRow {
  id: string;
  user_id: string;
  game_id: string;
  rating_before: number;
  rating_after: number;
  delta: number;
  mode: string;
  created_at: string;
}

export interface ReputationRow {
  id: string;
  user_id: string;
  game_id: string | null;
  delta: number;
  reason: string;
  created_at: string;
}

export interface AchievementRow {
  id: string;
  user_id: string;
  code: string;
  progress: number;
  unlocked_at: string | null;
}

export interface BotMatchRow {
  game_id: string;
  player_id: string;
  bot_id: string;
  entry_stroops: number;
  bot_stake_stroops: number;
  player_score: number;
  bot_score: number;
  winner: string;
  fee_stroops: number;
  player_reward_stroops: number;
  treasury_delta_stroops: number;
  settlement_tx_hash: string | null;
  created_at: string;
}

export type TransactionKind =
  | "deposit"
  | "transfer"
  | "entry"
  | "payout"
  | "refund"
  | "fee"
  | "bot_settlement"
  | "treasury_funding"
  | "treasury_withdrawal";

export type TransactionStatus =
  | "preparing"
  | "awaiting_wallet"
  | "signing"
  | "submitting"
  | "confirming"
  | "confirmed"
  | "failed";

export interface TransactionRow {
  id: string;
  user_id: string | null;
  game_id: string | null;
  kind: TransactionKind;
  direction: "in" | "out";
  amount_stroops: number;
  status: TransactionStatus;
  tx_hash: string | null;
  ledger: number | null;
  address: string | null;
  error: string | null;
  explorer_url: string | null;
  metadata: string | null;
  demo: number;
  created_at: string;
  updated_at: string;
  confirmed_at: string | null;
}

export interface TreasuryTransactionRow {
  id: string;
  kind: string;
  direction: "in" | "out";
  amount_stroops: number;
  balance_after_stroops: number | null;
  tx_hash: string | null;
  game_id: string | null;
  actor: string | null;
  metadata: string | null;
  created_at: string;
}

export interface AdminActionRow {
  id: string;
  admin_wallet: string;
  action: string;
  target: string | null;
  payload: string | null;
  tx_hash: string | null;
  created_at: string;
}

export interface SettingRow {
  key: string;
  value: string;
  updated_at: string;
  updated_by: string | null;
}

export interface LeaderboardRow {
  user_id: string;
  username: string;
  avatar: string | null;
  theme: string;
  rating: number;
  reputation: number;
  wins: number;
  losses: number;
  games_played: number;
  current_streak: number;
  best_streak: number;
  human_games: number;
}
