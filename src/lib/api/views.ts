/** Client-safe view types mirrored from the server services. No secrets here. */

export type GameModeView = "pvp" | "bot" | "private";
export type GameStatusView =
  | "waiting"
  | "joined"
  | "active"
  | "finished"
  | "settled"
  | "cancelled"
  | "expired"
  | "refunded";

export interface GameViewRow {
  id: string;
  code: string;
  mode: GameModeView;
  status: GameStatusView;
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
  escrow_state: string;
  settlement_status: string | null;
  contract_game_id: string | null;
  result_hash: string | null;
  settle_tx_hash: string | null;
  demo: number;
  created_at: string;
  expires_at: string;
  started_at: string | null;
  finished_at: string | null;
  settled_at: string | null;
}

export interface GamePlayerView {
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
  username: string;
  avatar: string | null;
  rating: number;
  theme?: string | null;
  custody?: "external" | "managed" | "bot";
}

export interface TargetView {
  id: number;
  kind: "blue" | "gold" | "red";
  x: number;
  y: number;
  radius: number;
  points: number;
  spawnAtMs: number;
  expiresAtMs: number;
}

export interface MatchView {
  game: GameViewRow;
  players: GamePlayerView[];
  botScore: number | null;
  serverTimeMs: number;
  schedule: TargetView[];
  liveScores: Record<string, number>;
  startAtMs: number | null;
  countdownMs: number;
  maxScore: number;
  escrow: { creator: boolean; joiner: boolean };
}

export interface ProfileView {
  user_id: string;
  username: string;
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
}

export interface WalletView {
  id: string;
  address: string;
  custody: "external" | "managed";
  provider: string;
  network: string;
}

export interface AchievementView {
  code: string;
  name: string;
  description: string;
  icon: string;
  unlocked: boolean;
}

export interface MatchRowView {
  id: string;
  game_id: string;
  user_id: string;
  opponent_id: string | null;
  opponent_label: string;
  mode: GameModeView;
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

export type TransactionStatusView =
  | "preparing"
  | "awaiting_wallet"
  | "signing"
  | "submitting"
  | "confirming"
  | "confirmed"
  | "failed";

export interface TransactionView {
  id: string;
  user_id: string | null;
  game_id: string | null;
  kind: string;
  direction: "in" | "out";
  amount_stroops: number;
  status: TransactionStatusView;
  tx_hash: string | null;
  ledger: number | null;
  address: string | null;
  error: string | null;
  explorer_url: string | null;
  demo: number;
  created_at: string;
  confirmed_at: string | null;
}

export interface DashboardView {
  profile: ProfileView;
  wallet: WalletView | null;
  balanceXlm: string | null;
  rank: number;
  recentMatches: MatchRowView[];
  activeGames: GameViewRow[];
  transactions: TransactionView[];
  achievements: AchievementView[];
  bot: { available: boolean; reason?: string };
  escrowAvailable: boolean;
}

export interface DirectoryPlayer {
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

export interface LeaderboardEntry extends DirectoryPlayer {
  position: number;
}

export interface EscrowHandoffView {
  mode: "wallet-signature" | "confirmed" | "offchain";
  confirmed?: boolean;
  transactionId?: string;
  xdr?: string;
  txHash?: string;
  networkPassphrase?: string;
}

export interface DuelCreationResponse {
  game: GameViewRow;
  invite: { id: string; code: string; status: string; expires_at: string } | null;
  escrow: EscrowHandoffView;
  bot?: { id: string; name: string } | null;
}

export interface PlayerProfileResponse {
  profile: ProfileView;
  walletAddress: string | null;
  rank: number;
  matches: MatchRowView[];
  recentGames: GameViewRow[];
  achievements: AchievementView[];
  isSelf: boolean;
}

export interface SubmitResponse {
  game: GameViewRow;
  score: number;
  settled: boolean;
  waitingForOpponent?: boolean;
}

export interface SessionResponse {
  authenticated: boolean;
  user?: { id: string; email: string | null; provider: string; isAdmin: boolean };
  profile?: {
    username: string;
    avatar: string | null;
    theme: string;
    rating: number;
    reputation: number;
    wins: number;
    losses: number;
    gamesPlayed: number;
    onboardingComplete: boolean;
    currentStreak: number;
  } | null;
  wallet?: WalletView | null;
  providers?: {
    google: boolean;
    x: boolean;
    contract: boolean;
    settlementKey: boolean;
    adminWallet: boolean;
    database: boolean;
    demoMode: boolean;
  };
  persistence?: string;
}
