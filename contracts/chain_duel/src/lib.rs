#![no_std]
//! Chain Duel — Stellar/Soroban escrow, settlement and protocol treasury contract.
//!
//! The contract owns the money. The game server owns the truth about who won:
//! only the configured admin (the Chain Duel verifier) may settle a game, while
//! only the designated developer wallet may withdraw treasury revenue — and a
//! withdrawal can only ever land back at that same wallet.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, token,
    Address, BytesN, Env,
};

/// Protocol fee is expressed in basis points (1 BPS = 0.01%).
pub const BPS_DENOMINATOR: i128 = 10_000;
pub const DEFAULT_FEE_BPS: u32 = 1_000; // 10%
pub const MAX_FEE_BPS: u32 = 3_000; // 30% hard ceiling

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    Paused = 4,
    GameNotFound = 5,
    GameNotWaiting = 6,
    GameNotJoined = 7,
    GameNotActive = 8,
    GameAlreadySettled = 9,
    GameExpired = 10,
    GameNotExpired = 11,
    DuplicatePlayer = 12,
    InvalidAmount = 13,
    InvalidFee = 14,
    InvalidWinner = 15,
    InsufficientBotLiquidity = 16,
    InsufficientTreasury = 17,
    ExceedsMaxPayout = 18,
    BelowMinTreasury = 19,
    NothingToWithdraw = 20,
    InvalidStatus = 21,
    Overflow = 22,
}

// Mode and status are plain u32 on the wire. That keeps the ABI trivially
// portable to any client (JS, Go, CLI) with no enum-encoding ambiguity, while
// the constants keep the Rust source readable.

/// Created by player one, waiting for an opponent.
pub const STATUS_WAITING: u32 = 0;
/// Both players are in escrow, waiting for the server to start the match.
pub const STATUS_JOINED: u32 = 1;
/// Match is live offchain. Escrow is locked.
pub const STATUS_ACTIVE: u32 = 2;
/// Match finished offchain, result published, awaiting settlement.
pub const STATUS_FINISHED: u32 = 3;
/// Winner and protocol have been paid.
pub const STATUS_SETTLED: u32 = 4;
/// Creator cancelled before an opponent joined; entry refunded.
pub const STATUS_CANCELLED: u32 = 5;
/// Nobody joined before expiry; entry refunded.
pub const STATUS_EXPIRED: u32 = 6;

/// Two human wallets stake an equal entry.
pub const MODE_PVP: u32 = 0;
/// One human wallet stakes an entry against protocol bot liquidity.
pub const MODE_BOT: u32 = 1;

#[contracttype]
#[derive(Clone, Debug)]
pub struct Game {
    pub id: BytesN<32>,
    pub mode: u32,
    pub creator: Address,
    pub opponent: Option<Address>,
    pub entry_amount: i128,
    /// Protocol liquidity committed by the treasury for a bot game.
    pub bot_stake: i128,
    pub fee_bps: u32,
    pub status: u32,
    pub winner: Option<Address>,
    pub player_one_score: i64,
    pub player_two_score: i64,
    pub created_ledger: u32,
    pub expiry_ledger: u32,
    pub settled_ledger: u32,
    /// Total value locked for this game (both sides).
    pub escrow: i128,
    pub payout: i128,
    pub fee: i128,
    pub result_hash: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Config {
    /// Settlement/verifier authority: may settle games and change protocol
    /// settings. Held by the Chain Duel server signing key.
    pub admin: Address,
    /// Designated developer wallet: the ONLY address that may withdraw from
    /// the protocol treasury, and the ONLY address a withdrawal can land at.
    /// Never the server key in a production deployment.
    pub treasury: Address,
    /// Stellar Asset Contract used for entries and payouts (native XLM SAC on Testnet).
    pub token: Address,
    pub fee_bps: u32,
    pub paused: bool,
    pub bot_enabled: bool,
    pub max_entry: i128,
    pub max_payout: i128,
    pub min_treasury_balance: i128,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Stats {
    pub games_created: u64,
    pub games_settled: u64,
    pub games_cancelled: u64,
    pub volume: i128,
    pub fees_collected: i128,
    pub payout_total: i128,
    pub bot_games: u64,
    pub bot_wins: u64,
    pub player_wins: u64,
    pub bot_payouts: i128,
}

#[contracttype]
#[derive(Clone, Debug)]
pub enum DataKey {
    Config,
    Stats,
    Game(BytesN<32>),
    /// Free protocol liquidity reserved for computer matches.
    BotPool,
    /// Accrued protocol fees not yet withdrawn.
    AccruedFees,
    /// Value currently locked in live escrows.
    LockedEscrow,
}

#[contract]
pub struct ChainDuel;

fn read_config(env: &Env) -> Config {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
}

fn write_config(env: &Env, config: &Config) {
    env.storage().instance().set(&DataKey::Config, config);
}

fn read_stats(env: &Env) -> Stats {
    env.storage()
        .instance()
        .get(&DataKey::Stats)
        .unwrap_or(Stats {
            games_created: 0,
            games_settled: 0,
            games_cancelled: 0,
            volume: 0,
            fees_collected: 0,
            payout_total: 0,
            bot_games: 0,
            bot_wins: 0,
            player_wins: 0,
            bot_payouts: 0,
        })
}

fn write_stats(env: &Env, stats: &Stats) {
    env.storage().instance().set(&DataKey::Stats, stats);
}

fn bot_pool(env: &Env) -> i128 {
    env.storage().instance().get(&DataKey::BotPool).unwrap_or(0)
}

fn accrued_fees(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::AccruedFees)
        .unwrap_or(0)
}

fn locked_escrow(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::LockedEscrow)
        .unwrap_or(0)
}

fn write_game(env: &Env, game: &Game) {
    let key = DataKey::Game(game.id.clone());
    env.storage().persistent().set(&key, game);
    env.storage()
        .persistent()
        .extend_ttl(&key, 60 * 60 * 24 * 30, 60 * 60 * 24 * 90);
}

fn read_game(env: &Env, id: &BytesN<32>) -> Game {
    env.storage()
        .persistent()
        .get(&DataKey::Game(id.clone()))
        .unwrap_or_else(|| panic_with_error!(env, Error::GameNotFound))
}

fn token_client<'a>(env: &'a Env, config: &Config) -> token::Client<'a> {
    token::Client::new(env, &config.token)
}

fn require_admin(env: &Env) -> Address {
    let config = read_config(env);
    config.admin.require_auth();
    config.admin
}

fn checked_add(env: &Env, a: i128, b: i128) -> i128 {
    a.checked_add(b)
        .unwrap_or_else(|| panic_with_error!(env, Error::Overflow))
}

fn checked_sub(env: &Env, a: i128, b: i128) -> i128 {
    a.checked_sub(b)
        .unwrap_or_else(|| panic_with_error!(env, Error::Overflow))
}

fn split_pool(env: &Env, pool: i128, fee_bps: u32) -> (i128, i128) {
    if pool <= 0 {
        panic_with_error!(env, Error::InvalidAmount);
    }
    let fee = pool
        .checked_mul(fee_bps as i128)
        .unwrap_or_else(|| panic_with_error!(env, Error::Overflow))
        / BPS_DENOMINATOR;
    let payout = checked_sub(env, pool, fee);
    (payout, fee)
}

fn refund_escrow(env: &Env, game: &Game, config: &Config) {
    let client = token_client(env, config);
    let contract = env.current_contract_address();
    if game.escrow <= 0 {
        return;
    }
    if game.mode == MODE_BOT {
        // Player entry returns to the player, protocol liquidity returns to the pool.
        client.transfer(&contract, &game.creator, &game.entry_amount);
        if game.bot_stake > 0 {
            let pool = bot_pool(env);
            env.storage()
                .instance()
                .set(&DataKey::BotPool, &checked_add(env, pool, game.bot_stake));
        }
    } else {
        client.transfer(&contract, &game.creator, &game.entry_amount);
        if let Some(opponent) = game.opponent.clone() {
            client.transfer(&contract, &opponent, &game.entry_amount);
        }
    }
    let locked = locked_escrow(env);
    env.storage()
        .instance()
        .set(&DataKey::LockedEscrow, &checked_sub(env, locked, game.escrow));
}

#[contractimpl]
impl ChainDuel {
    pub fn __constructor(
        env: Env,
        admin: Address,
        treasury: Address,
        token: Address,
        fee_bps: u32,
        max_entry: i128,
        max_payout: i128,
        min_treasury_balance: i128,
    ) {
        if env.storage().instance().has(&DataKey::Config) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        if fee_bps > MAX_FEE_BPS {
            panic_with_error!(&env, Error::InvalidFee);
        }
        let config = Config {
            admin,
            treasury,
            token,
            fee_bps,
            paused: false,
            bot_enabled: true,
            max_entry,
            max_payout,
            min_treasury_balance,
        };
        write_config(&env, &config);
        env.storage().instance().set(&DataKey::BotPool, &0_i128);
        env.storage().instance().set(&DataKey::AccruedFees, &0_i128);
        env.storage().instance().set(&DataKey::LockedEscrow, &0_i128);
        write_stats(&env, &read_stats(&env));
    }

    // ---------------------------------------------------------------- reads

    pub fn get_config(env: Env) -> Config {
        read_config(&env)
    }

    pub fn get_stats(env: Env) -> Stats {
        read_stats(&env)
    }

    pub fn get_game(env: Env, id: BytesN<32>) -> Game {
        read_game(&env, &id)
    }

    pub fn get_bot_liquidity(env: Env) -> i128 {
        bot_pool(&env)
    }

    pub fn get_accrued_fees(env: Env) -> i128 {
        accrued_fees(&env)
    }

    pub fn get_locked_escrow(env: Env) -> i128 {
        locked_escrow(&env)
    }

    /// Funds the contract actually holds for this token.
    pub fn get_contract_balance(env: Env) -> i128 {
        let config = read_config(&env);
        token_client(&env, &config).balance(&env.current_contract_address())
    }

    /// Liquidity free to underwrite a computer match right now.
    pub fn available_bot_liquidity(env: Env) -> i128 {
        bot_pool(&env)
    }

    pub fn is_admin(env: Env, who: Address) -> bool {
        read_config(&env).admin == who
    }

    // ------------------------------------------------------------- lifecycle

    /// Player one commits an entry. For bot games the protocol immediately
    /// commits matching liquidity from the bot pool.
    pub fn create_game(
        env: Env,
        creator: Address,
        id: BytesN<32>,
        mode: u32,
        entry_amount: i128,
        expiry_ledger: u32,
    ) -> Game {
        creator.require_auth();
        let config = read_config(&env);
        if config.paused {
            panic_with_error!(&env, Error::Paused);
        }
        if entry_amount <= 0 || entry_amount > config.max_entry {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        if env.storage().persistent().has(&DataKey::Game(id.clone())) {
            panic_with_error!(&env, Error::InvalidStatus);
        }
        let now = env.ledger().sequence();
        if expiry_ledger <= now {
            panic_with_error!(&env, Error::GameExpired);
        }

        let client = token_client(&env, &config);
        let contract = env.current_contract_address();
        client.transfer(&creator, &contract, &entry_amount);

        if mode != MODE_BOT && mode != MODE_PVP {
            panic_with_error!(&env, Error::InvalidStatus);
        }
        let bot_stake = if mode == MODE_BOT {
            if !config.bot_enabled {
                panic_with_error!(&env, Error::Paused);
            }
            let pool = bot_pool(&env);
            if pool < entry_amount {
                panic_with_error!(&env, Error::InsufficientBotLiquidity);
            }
            env.storage()
                .instance()
                .set(&DataKey::BotPool, &checked_sub(&env, pool, entry_amount));
            entry_amount
        } else {
            0
        };

        let escrow = checked_add(&env, entry_amount, bot_stake);
        let locked = locked_escrow(&env);
        env.storage()
            .instance()
            .set(&DataKey::LockedEscrow, &checked_add(&env, locked, escrow));

        let game = Game {
            id: id.clone(),
            mode,
            creator: creator.clone(),
            opponent: None,
            entry_amount,
            bot_stake,
            fee_bps: config.fee_bps,
            status: STATUS_WAITING,
            winner: None,
            player_one_score: 0,
            player_two_score: 0,
            created_ledger: now,
            expiry_ledger,
            settled_ledger: 0,
            escrow,
            payout: 0,
            fee: 0,
            result_hash: BytesN::from_array(&env, &[0u8; 32]),
        };
        write_game(&env, &game);

        let mut stats = read_stats(&env);
        stats.games_created += 1;
        stats.volume = checked_add(&env, stats.volume, escrow);
        if mode == MODE_BOT {
            stats.bot_games += 1;
        }
        write_stats(&env, &stats);

        env.events().publish(
            (symbol_short!("game"), symbol_short!("create")),
            (id, creator, mode, entry_amount, escrow),
        );
        game
    }

    /// Player two matches the entry. Not available for bot games.
    pub fn join_game(env: Env, player: Address, id: BytesN<32>) -> Game {
        player.require_auth();
        let config = read_config(&env);
        if config.paused {
            panic_with_error!(&env, Error::Paused);
        }
        let mut game = read_game(&env, &id);
        if game.mode != MODE_PVP {
            panic_with_error!(&env, Error::InvalidStatus);
        }
        if game.status != STATUS_WAITING {
            panic_with_error!(&env, Error::GameNotWaiting);
        }
        if game.creator == player {
            panic_with_error!(&env, Error::DuplicatePlayer);
        }
        if env.ledger().sequence() >= game.expiry_ledger {
            panic_with_error!(&env, Error::GameExpired);
        }

        let client = token_client(&env, &config);
        let contract = env.current_contract_address();
        client.transfer(&player, &contract, &game.entry_amount);

        game.opponent = Some(player.clone());
        game.status = STATUS_JOINED;
        game.escrow = checked_add(&env, game.escrow, game.entry_amount);
        write_game(&env, &game);

        let locked = locked_escrow(&env);
        env.storage()
            .instance()
            .set(&DataKey::LockedEscrow, &checked_add(&env, locked, game.entry_amount));

        env.events().publish(
            (symbol_short!("game"), symbol_short!("join")),
            (id, player, game.escrow),
        );
        game
    }

    /// Server marks the duel live. Only the settlement authority may do this.
    pub fn start_game(env: Env, id: BytesN<32>) -> Game {
        require_admin(&env);
        let mut game = read_game(&env, &id);
        let ready = game.status == STATUS_JOINED
            || (game.mode == MODE_BOT && game.status == STATUS_WAITING);
        if !ready {
            panic_with_error!(&env, Error::GameNotJoined);
        }
        game.status = STATUS_ACTIVE;
        write_game(&env, &game);
        env.events()
            .publish((symbol_short!("game"), symbol_short!("start")), id);
        game
    }

    /// Server publishes the verified result and pays out atomically.
    pub fn settle_game(
        env: Env,
        id: BytesN<32>,
        winner: Address,
        player_one_score: i64,
        player_two_score: i64,
        result_hash: BytesN<32>,
    ) -> Game {
        require_admin(&env);
        let config = read_config(&env);
        let mut game = read_game(&env, &id);

        if matches!(game.status, STATUS_SETTLED | STATUS_CANCELLED | STATUS_EXPIRED) {
            panic_with_error!(&env, Error::GameAlreadySettled);
        }
        let valid_winner = winner == game.creator
            || game.opponent.clone().map(|o| o == winner).unwrap_or(false)
            || (game.mode == MODE_BOT && winner == config.treasury);
        if !valid_winner {
            panic_with_error!(&env, Error::InvalidWinner);
        }

        let pool = game.escrow;
        let (payout, fee) = split_pool(&env, pool, game.fee_bps);
        if payout > config.max_payout {
            panic_with_error!(&env, Error::ExceedsMaxPayout);
        }

        let client = token_client(&env, &config);
        let contract = env.current_contract_address();
        client.transfer(&contract, &winner, &payout);

        game.winner = Some(winner.clone());
        game.player_one_score = player_one_score;
        game.player_two_score = player_two_score;
        game.status = STATUS_SETTLED;
        game.settled_ledger = env.ledger().sequence();
        game.payout = payout;
        game.fee = fee;
        game.result_hash = result_hash;
        write_game(&env, &game);

        let locked = locked_escrow(&env);
        env.storage()
            .instance()
            .set(&DataKey::LockedEscrow, &checked_sub(&env, locked, pool));

        let fees = accrued_fees(&env);
        env.storage()
            .instance()
            .set(&DataKey::AccruedFees, &checked_add(&env, fees, fee));

        let mut stats = read_stats(&env);
        stats.games_settled += 1;
        stats.fees_collected = checked_add(&env, stats.fees_collected, fee);
        stats.payout_total = checked_add(&env, stats.payout_total, payout);
        if game.mode == MODE_BOT {
            if winner == config.treasury {
                stats.bot_wins += 1;
            } else {
                stats.player_wins += 1;
                stats.bot_payouts = checked_add(&env, stats.bot_payouts, payout);
            }
        }
        write_stats(&env, &stats);

        env.events().publish(
            (symbol_short!("game"), symbol_short!("settle")),
            (id, winner, payout, fee),
        );
        game
    }

    /// Creator cancels a duel nobody joined. Funds return immediately.
    pub fn cancel_game(env: Env, caller: Address, id: BytesN<32>) -> Game {
        caller.require_auth();
        let config = read_config(&env);
        let mut game = read_game(&env, &id);
        if caller != game.creator && caller != config.admin {
            panic_with_error!(&env, Error::Unauthorized);
        }
        if game.status != STATUS_WAITING {
            panic_with_error!(&env, Error::GameNotWaiting);
        }
        refund_escrow(&env, &game, &config);
        game.status = STATUS_CANCELLED;
        write_game(&env, &game);

        let mut stats = read_stats(&env);
        stats.games_cancelled += 1;
        write_stats(&env, &stats);

        env.events().publish(
            (symbol_short!("game"), symbol_short!("cancel")),
            (id, caller, game.entry_amount),
        );
        game
    }

    /// Anyone may trigger a refund once the join window has passed. The money
    /// only ever goes back to the wallets that deposited it.
    pub fn claim_refund(env: Env, id: BytesN<32>) -> Game {
        let config = read_config(&env);
        let mut game = read_game(&env, &id);
        if !matches!(game.status, STATUS_WAITING | STATUS_JOINED) {
            panic_with_error!(&env, Error::InvalidStatus);
        }
        if env.ledger().sequence() < game.expiry_ledger {
            panic_with_error!(&env, Error::GameNotExpired);
        }
        refund_escrow(&env, &game, &config);
        game.status = STATUS_EXPIRED;
        write_game(&env, &game);
        env.events()
            .publish((symbol_short!("game"), symbol_short!("refund")), id);
        game
    }

    // ------------------------------------------------------------- treasury

    /// Adds protocol liquidity for computer matches. Anyone may donate.
    pub fn fund_bot_pool(env: Env, from: Address, amount: i128) {
        from.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let config = read_config(&env);
        let client = token_client(&env, &config);
        client.transfer(&from, &env.current_contract_address(), &amount);
        let pool = bot_pool(&env);
        env.storage()
            .instance()
            .set(&DataKey::BotPool, &checked_add(&env, pool, amount));
        env.events().publish(
            (symbol_short!("treasury"), symbol_short!("fund")),
            (from, amount),
        );
    }

    /// Treasury revenue (accrued protocol fees) may only ever be withdrawn by
    /// the designated developer wallet, and only to that same wallet.
    ///
    /// Note this is deliberately NOT an admin operation: the server's
    /// settlement key can pay out games but can never move treasury revenue.
    pub fn withdraw_treasury(env: Env, amount: i128) -> i128 {
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let config = read_config(&env);
        // Only the designated developer wallet, proving it is itself.
        config.treasury.require_auth();
        let fees = accrued_fees(&env);
        if amount > fees {
            panic_with_error!(&env, Error::InsufficientTreasury);
        }
        let remaining = checked_sub(&env, fees, amount);
        env.storage().instance().set(&DataKey::AccruedFees, &remaining);

        let client = token_client(&env, &config);
        client.transfer(&env.current_contract_address(), &config.treasury, &amount);

        env.events().publish(
            (symbol_short!("treasury"), symbol_short!("withdraw")),
            (config.treasury.clone(), amount, remaining),
        );
        remaining
    }

    /// Moves unallocated bot liquidity back to the treasury wallet.
    pub fn withdraw_bot_liquidity(env: Env, amount: i128) -> i128 {
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let config = read_config(&env);
        config.treasury.require_auth();
        let pool = bot_pool(&env);
        if amount > pool {
            panic_with_error!(&env, Error::InsufficientBotLiquidity);
        }
        let remaining = checked_sub(&env, pool, amount);
        env.storage().instance().set(&DataKey::BotPool, &remaining);
        let client = token_client(&env, &config);
        client.transfer(&env.current_contract_address(), &config.treasury, &amount);
        env.events().publish(
            (symbol_short!("treasury"), symbol_short!("unlock")),
            (config.treasury.clone(), amount, remaining),
        );
        remaining
    }

    // ------------------------------------------------------- admin settings

    pub fn set_fee_bps(env: Env, fee_bps: u32) -> Config {
        require_admin(&env);
        if fee_bps > MAX_FEE_BPS {
            panic_with_error!(&env, Error::InvalidFee);
        }
        let mut config = read_config(&env);
        config.fee_bps = fee_bps;
        write_config(&env, &config);
        config
    }

    pub fn set_paused(env: Env, paused: bool) -> Config {
        require_admin(&env);
        let mut config = read_config(&env);
        config.paused = paused;
        write_config(&env, &config);
        env.events()
            .publish((symbol_short!("admin"), symbol_short!("pause")), paused);
        config
    }

    pub fn set_bot_enabled(env: Env, enabled: bool) -> Config {
        require_admin(&env);
        let mut config = read_config(&env);
        config.bot_enabled = enabled;
        write_config(&env, &config);
        config
    }

    /// Rotates the designated developer wallet. Withdrawals are hard-bound to
    /// this address, and only it may call the withdrawal entry points. The
    /// settlement authority is intentionally left untouched.
    pub fn set_treasury(env: Env, treasury: Address) -> Config {
        require_admin(&env);
        let mut config = read_config(&env);
        config.treasury = treasury.clone();
        write_config(&env, &config);
        env.events()
            .publish((symbol_short!("admin"), symbol_short!("treasury")), treasury);
        config
    }

    /// Rotates the settlement/verifier authority. Admin-only, and separate from
    /// the treasury so the protocol can change its server signer without ever
    /// touching the developer wallet that controls withdrawals.
    pub fn set_admin(env: Env, admin: Address) -> Config {
        require_admin(&env);
        let mut config = read_config(&env);
        config.admin = admin.clone();
        write_config(&env, &config);
        env.events()
            .publish((symbol_short!("admin"), symbol_short!("setadmin")), admin);
        config
    }

    pub fn set_limits(
        env: Env,
        max_entry: i128,
        max_payout: i128,
        min_treasury_balance: i128,
    ) -> Config {
        require_admin(&env);
        let mut config = read_config(&env);
        config.max_entry = max_entry;
        config.max_payout = max_payout;
        config.min_treasury_balance = min_treasury_balance;
        write_config(&env, &config);
        config
    }
}

#[cfg(test)]
mod test;
