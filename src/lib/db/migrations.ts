/**
 * One portable schema. SQLite and Postgres are close enough here (TEXT ids,
 * TEXT timestamps, INTEGER counters) that a single DDL keeps them honest and
 * removes any chance of the two dialects drifting apart.
 */
export const SCHEMA_VERSION = 1;

export const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    primary_wallet TEXT,
    email TEXT,
    auth_provider TEXT NOT NULL,
    provider_account_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_seen_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS users_provider_idx ON users (auth_provider, provider_account_id);
  CREATE UNIQUE INDEX IF NOT EXISTS users_wallet_idx ON users (primary_wallet);

  CREATE TABLE IF NOT EXISTS profiles (
    user_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    username_lower TEXT NOT NULL,
    avatar TEXT,
    theme TEXT NOT NULL DEFAULT 'neon',
    onboarding_complete INTEGER NOT NULL DEFAULT 0,
    rating INTEGER NOT NULL DEFAULT 1000,
    reputation INTEGER NOT NULL DEFAULT 100,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    games_played INTEGER NOT NULL DEFAULT 0,
    human_games INTEGER NOT NULL DEFAULT 0,
    bot_games INTEGER NOT NULL DEFAULT 0,
    bot_wins INTEGER NOT NULL DEFAULT 0,
    bot_losses INTEGER NOT NULL DEFAULT 0,
    current_streak INTEGER NOT NULL DEFAULT 0,
    best_streak INTEGER NOT NULL DEFAULT 0,
    total_earned_stroops INTEGER NOT NULL DEFAULT 0,
    total_wagered_stroops INTEGER NOT NULL DEFAULT 0,
    fees_paid_stroops INTEGER NOT NULL DEFAULT 0,
    achievements TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_idx ON profiles (username_lower);
  CREATE INDEX IF NOT EXISTS profiles_rating_idx ON profiles (rating DESC);

  CREATE TABLE IF NOT EXISTS wallets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    address TEXT NOT NULL,
    provider TEXT NOT NULL,
    custody TEXT NOT NULL DEFAULT 'external',
    is_primary INTEGER NOT NULL DEFAULT 0,
    label TEXT,
    network TEXT NOT NULL,
    linked_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS wallets_address_idx ON wallets (address);
  CREATE INDEX IF NOT EXISTS wallets_user_idx ON wallets (user_id);

  -- Managed-wallet key material lives in its own table so it can never leak
  -- through an ordinary wallet query. Ciphertext is AES-256-GCM.
  CREATE TABLE IF NOT EXISTS wallet_keys (
    wallet_id TEXT PRIMARY KEY,
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    auth_tag TEXT NOT NULL,
    algo TEXT NOT NULL DEFAULT 'aes-256-gcm',
    created_at TEXT NOT NULL,
    rotated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    wallet_address TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    user_agent_hash TEXT
  );
  CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
  CREATE INDEX IF NOT EXISTS sessions_hash_idx ON sessions (token_hash);

  CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    game_type TEXT NOT NULL DEFAULT 'pulse_duel',
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'public',
    creator_id TEXT NOT NULL,
    opponent_id TEXT,
    winner_id TEXT,
    entry_stroops INTEGER NOT NULL,
    pool_stroops INTEGER NOT NULL DEFAULT 0,
    fee_bps INTEGER NOT NULL DEFAULT 1000,
    payout_stroops INTEGER NOT NULL DEFAULT 0,
    fee_stroops INTEGER NOT NULL DEFAULT 0,
    player_one_score INTEGER NOT NULL DEFAULT 0,
    player_two_score INTEGER NOT NULL DEFAULT 0,
    seed TEXT NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 60000,
    escrow_state TEXT NOT NULL DEFAULT 'none',
    settlement_status TEXT,
    contract_game_id TEXT,
    result_hash TEXT,
    create_tx_hash TEXT,
    join_tx_hash TEXT,
    settle_tx_hash TEXT,
    demo INTEGER NOT NULL DEFAULT 0,
    bot_outcome TEXT,
    bot_state TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    settled_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS games_code_idx ON games (code);
  CREATE INDEX IF NOT EXISTS games_status_idx ON games (status);
  CREATE INDEX IF NOT EXISTS games_creator_idx ON games (creator_id);

  CREATE TABLE IF NOT EXISTS game_players (
    id TEXT PRIMARY KEY,
    game_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    seat INTEGER NOT NULL,
    address TEXT,
    score INTEGER NOT NULL DEFAULT 0,
    max_combo INTEGER NOT NULL DEFAULT 0,
    hits INTEGER NOT NULL DEFAULT 0,
    misses INTEGER NOT NULL DEFAULT 0,
    is_bot INTEGER NOT NULL DEFAULT 0,
    result TEXT,
    joined_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS game_players_seat_idx ON game_players (game_id, seat);
  CREATE UNIQUE INDEX IF NOT EXISTS game_players_user_idx ON game_players (game_id, user_id);

  CREATE TABLE IF NOT EXISTS game_events (
    id {{AUTO_ID}},
    game_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    seat INTEGER,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS game_events_game_idx ON game_events (game_id, seq);

  CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    game_id TEXT NOT NULL,
    creator_id TEXT NOT NULL,
    invited_user_id TEXT,
    channel TEXT NOT NULL DEFAULT 'link',
    status TEXT NOT NULL,
    entry_stroops INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    responded_at TEXT,
    accepted_by TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS invites_code_idx ON invites (code);
  CREATE INDEX IF NOT EXISTS invites_game_idx ON invites (game_id);
  CREATE INDEX IF NOT EXISTS invites_invited_idx ON invites (invited_user_id, status);

  CREATE TABLE IF NOT EXISTS matchmaking_queue (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    game_type TEXT NOT NULL,
    entry_stroops INTEGER NOT NULL,
    demo INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    game_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS queue_status_idx ON matchmaking_queue (status, game_type, entry_stroops);
  CREATE INDEX IF NOT EXISTS queue_user_idx ON matchmaking_queue (user_id);

  CREATE TABLE IF NOT EXISTS matches (
    id TEXT PRIMARY KEY,
    game_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    opponent_id TEXT,
    opponent_label TEXT NOT NULL,
    mode TEXT NOT NULL,
    result TEXT NOT NULL,
    score_for INTEGER NOT NULL,
    score_against INTEGER NOT NULL,
    entry_stroops INTEGER NOT NULL DEFAULT 0,
    reward_stroops INTEGER NOT NULL DEFAULT 0,
    rating_delta INTEGER NOT NULL DEFAULT 0,
    settlement_tx_hash TEXT,
    demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS matches_game_user_idx ON matches (game_id, user_id);
  CREATE INDEX IF NOT EXISTS matches_user_idx ON matches (user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS ratings (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    game_id TEXT NOT NULL,
    rating_before INTEGER NOT NULL,
    rating_after INTEGER NOT NULL,
    delta INTEGER NOT NULL,
    mode TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ratings_user_idx ON ratings (user_id);

  CREATE TABLE IF NOT EXISTS reputation (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    game_id TEXT,
    delta INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS reputation_user_idx ON reputation (user_id);

  CREATE TABLE IF NOT EXISTS achievements (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    code TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    unlocked_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS achievements_user_code_idx ON achievements (user_id, code);

  CREATE TABLE IF NOT EXISTS bot_matches (
    game_id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    entry_stroops INTEGER NOT NULL,
    bot_stake_stroops INTEGER NOT NULL,
    player_score INTEGER NOT NULL,
    bot_score INTEGER NOT NULL,
    winner TEXT NOT NULL,
    fee_stroops INTEGER NOT NULL,
    player_reward_stroops INTEGER NOT NULL,
    treasury_delta_stroops INTEGER NOT NULL,
    settlement_tx_hash TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    game_id TEXT,
    kind TEXT NOT NULL,
    direction TEXT NOT NULL,
    amount_stroops INTEGER NOT NULL,
    status TEXT NOT NULL,
    tx_hash TEXT,
    ledger INTEGER,
    address TEXT,
    error TEXT,
    explorer_url TEXT,
    metadata TEXT,
    demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    confirmed_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS transactions_hash_idx ON transactions (tx_hash);
  CREATE INDEX IF NOT EXISTS transactions_user_idx ON transactions (user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS transactions_game_idx ON transactions (game_id);

  CREATE TABLE IF NOT EXISTS treasury_transactions (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    direction TEXT NOT NULL,
    amount_stroops INTEGER NOT NULL,
    balance_after_stroops INTEGER,
    tx_hash TEXT,
    game_id TEXT,
    actor TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS treasury_tx_idx ON treasury_transactions (created_at DESC);

  CREATE TABLE IF NOT EXISTS admin_actions (
    id TEXT PRIMARY KEY,
    admin_wallet TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    payload TEXT,
    tx_hash TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS admin_actions_idx ON admin_actions (created_at DESC);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT
  );

  CREATE TABLE IF NOT EXISTS stellar_nonces (
    nonce TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS nonce_address_idx ON stellar_nonces (address);
  `,
  `
  -- A single Stellar transaction can settle several ledger lines (winner
  -- payout, protocol fee, treasury movement). The hash therefore identifies a
  -- transaction, not a unique row: index it, do not constrain it.
  DROP INDEX IF EXISTS transactions_hash_idx;
  CREATE INDEX IF NOT EXISTS transactions_hash_idx ON transactions (tx_hash);
  `,
];
