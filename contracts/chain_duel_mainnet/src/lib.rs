#![no_std]
//! Chain Duel Mainnet escrow. One designated wallet deploys, administers and
//! collects fees. Player liabilities, bot liquidity, protocol fees and ecosystem
//! fees are separate. The contract replays participant-authorized Pulse inputs;
//! an administrator or backend score is never a payout instruction.

use pulse_replay::{
    bot_score, build_schedule, Session, ABANDONMENT_WINDOW_MS, COUNTDOWN_MS, GAME_DURATION_MS,
    MAX_TRANSCRIPT_BYTES,
};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, token,
    Address, Bytes, BytesN, Env,
};
mod verification;
use verification::{
    enrollment_message, hex_seed, input_message, rules_hash, PlayerInputs, RULES_VERSION,
    START_CONFIRMATION_BUFFER_MS,
};

/// Protocol fee is expressed in basis points (1 BPS = 0.01%).
pub const BPS_DENOMINATOR: i128 = 10_000;
pub const DEFAULT_FEE_BPS: u32 = 1_000; // 10%
pub const MAX_FEE_BPS: u32 = 3_000; // 30% hard ceiling
/// Entry bounds apply to one player, not the combined escrow.
pub const MIN_ENTRY: i128 = 25 * 10_000_000;
pub const MAX_ENTRY: i128 = 10_000 * 10_000_000;
pub const DESIGNATED_ADMIN: &str = "GCQKVXWIQHVGUOUHZR2O6YBWBNNPKIYH5AWQHXHF3EYRHM73WIWVSK7K";
pub const MAINNET_USDC: &str = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
pub const TESTNET_USDC: &str = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
pub const TESTNET_XLM: &str = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

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
    WithdrawalAlreadyExecuted = 23,
    InvalidResult = 24,
    InvalidToken = 25,
    InvalidInputKey = 26,
    InputClosed = 27,
    InvalidSequence = 28,
    InputDeadline = 29,
    MatchNotEnded = 30,
    InputsPending = 31,
    InvalidTranscript = 32,
    FutureInput = 33,
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
    pub protocol_fee_bps: u32,
    pub ecosystem_fee_bps: u32,
    /// Limits on existing liabilities cannot be changed by a later admin action.
    pub max_payout: i128,
    pub status: u32,
    pub winner: Option<Address>,
    pub player_one_score: i64,
    pub player_two_score: i64,
    pub player_one_combo: i64,
    pub player_two_combo: i64,
    pub created_ledger: u32,
    pub expiry_ledger: u32,
    pub settled_ledger: u32,
    /// Total value locked for this game (both sides).
    pub escrow: i128,
    pub payout: i128,
    pub fee: i128,
    pub protocol_fee: i128,
    pub ecosystem_fee: i128,
    pub result_hash: BytesN<32>,
    pub verification_version: u32,
    pub seed: BytesN<32>,
    /// Countdown base, play clock and deadline come from Stellar ledger time.
    pub started_at_ms: u64,
    pub started_ledger: u32,
    pub play_start_ms: u64,
    pub end_at_ms: u64,
    pub input_deadline_ms: u64,
    pub inputs_one: PlayerInputs,
    pub inputs_two: PlayerInputs,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Config {
    /// The sole external administrator. It does not decide game outcomes.
    /// This address is immutable after constructor initialization.
    pub admin: Address,
    /// Same designated wallet; receives legitimate computer wins and free liquidity.
    pub treasury: Address,
    pub protocol_fee_recipient: Address,
    pub ecosystem_fee_recipient: Address,
    /// The designated wallet holds the ecosystem allocation separately in accounting.
    pub ecosystem_beneficiary: Address,
    /// Immutable seven-decimal asset, verified as official Mainnet USDC at deployment.
    pub token: Address,
    pub fee_bps: u32,
    pub protocol_fee_bps: u32,
    pub ecosystem_fee_bps: u32,
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
    pub protocol_fees_collected: i128,
    pub ecosystem_fees_collected: i128,
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
    ProtocolFees,
    EcosystemFees,
    /// Value currently locked in live escrows.
    LockedEscrow,
    Withdrawal(BytesN<32>),
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
    extend_instance(env);
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
            protocol_fees_collected: 0,
            ecosystem_fees_collected: 0,
            payout_total: 0,
            bot_games: 0,
            bot_wins: 0,
            player_wins: 0,
            bot_payouts: 0,
        })
}

fn write_stats(env: &Env, stats: &Stats) {
    env.storage().instance().set(&DataKey::Stats, stats);
    extend_instance(env);
}

fn bot_pool(env: &Env) -> i128 {
    env.storage().instance().get(&DataKey::BotPool).unwrap_or(0)
}

fn protocol_fees(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::ProtocolFees)
        .unwrap_or(0)
}

fn ecosystem_fees(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::EcosystemFees)
        .unwrap_or(0)
}

fn accrued_fees(env: &Env) -> i128 {
    checked_add(env, protocol_fees(env), ecosystem_fees(env))
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
    extend_persistent(env, &key);
    extend_instance(env);
}

// TTL arguments are ledgers. At the expected five-second cadence these target
// 30/90 days, bounded by the network maximum. Archived state remains restorable.
fn ttl_bounds(env: &Env) -> (u32, u32) {
    let target = core::cmp::min(env.storage().max_ttl(), 90 * 24 * 60 * 60 / 5);
    (
        core::cmp::min(30 * 24 * 60 * 60 / 5, target.saturating_sub(1)),
        target,
    )
}

fn extend_instance(env: &Env) {
    let (threshold, target) = ttl_bounds(env);
    if target > 0 {
        env.storage().instance().extend_ttl(threshold, target);
    }
}

fn extend_persistent(env: &Env, key: &DataKey) {
    let (threshold, target) = ttl_bounds(env);
    if target > 0 {
        env.storage()
            .persistent()
            .extend_ttl(key, threshold, target);
    }
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

fn clock_ms(env: &Env) -> u64 {
    env.ledger()
        .timestamp()
        .checked_mul(1000)
        .unwrap_or_else(|| panic_with_error!(env, Error::Overflow))
}

fn add_time(env: &Env, at: u64, delta: u64) -> u64 {
    at.checked_add(delta)
        .unwrap_or_else(|| panic_with_error!(env, Error::Overflow))
}

fn verify_enrollment(
    env: &Env,
    id: &BytesN<32>,
    player: &Address,
    seat: u32,
    key: &BytesN<32>,
    proof: &BytesN<64>,
) {
    if key == &BytesN::from_array(env, &[0; 32]) {
        panic_with_error!(env, Error::InvalidInputKey);
    }
    env.crypto()
        .ed25519_verify(key, &enrollment_message(env, id, player, seat, key), proof);
}

fn validate_limits(env: &Env, max_entry: i128, max_payout: i128, min_treasury_balance: i128) {
    if max_entry < MIN_ENTRY
        || max_entry > MAX_ENTRY
        || max_payout < max_entry * 2
        || max_payout > MAX_ENTRY * 2
        || min_treasury_balance < 0
    {
        panic_with_error!(env, Error::InvalidAmount);
    }
}

fn checked_add(env: &Env, a: i128, b: i128) -> i128 {
    a.checked_add(b)
        .unwrap_or_else(|| panic_with_error!(env, Error::Overflow))
}

fn checked_sub(env: &Env, a: i128, b: i128) -> i128 {
    a.checked_sub(b)
        .unwrap_or_else(|| panic_with_error!(env, Error::Overflow))
}

fn split_pool(env: &Env, pool: i128, protocol_bps: u32, ecosystem_bps: u32) -> (i128, i128, i128) {
    if pool <= 0 {
        panic_with_error!(env, Error::InvalidAmount);
    }
    let protocol = pool
        .checked_mul(protocol_bps as i128)
        .unwrap_or_else(|| panic_with_error!(env, Error::Overflow))
        / BPS_DENOMINATOR;
    let ecosystem = pool
        .checked_mul(ecosystem_bps as i128)
        .unwrap_or_else(|| panic_with_error!(env, Error::Overflow))
        / BPS_DENOMINATOR;
    let payout = checked_sub(env, pool, checked_add(env, protocol, ecosystem));
    (payout, protocol, ecosystem)
}

fn require_solvency(env: &Env, config: &Config) {
    let liabilities = checked_add(
        env,
        locked_escrow(env),
        checked_add(env, bot_pool(env), accrued_fees(env)),
    );
    if token_client(env, config).balance(&env.current_contract_address()) < liabilities {
        panic_with_error!(env, Error::InsufficientTreasury);
    }
}

fn claim_withdrawal(env: &Env, id: &BytesN<32>) {
    let key = DataKey::Withdrawal(id.clone());
    if env.storage().persistent().has(&key) {
        panic_with_error!(env, Error::WithdrawalAlreadyExecuted);
    }
    env.storage().persistent().set(&key, &true);
    extend_persistent(env, &key);
    extend_instance(env);
}

fn withdraw_fees(env: &Env, ecosystem: bool, amount: i128, id: &BytesN<32>) -> i128 {
    let config = read_config(env);
    config.admin.require_auth();
    if amount <= 0 {
        panic_with_error!(env, Error::InvalidAmount);
    }
    require_solvency(env, &config);
    let available = if ecosystem {
        ecosystem_fees(env)
    } else {
        protocol_fees(env)
    };
    if amount > available {
        panic_with_error!(env, Error::InsufficientTreasury);
    }
    claim_withdrawal(env, id);
    let remaining = checked_sub(env, available, amount);
    let key = if ecosystem {
        DataKey::EcosystemFees
    } else {
        DataKey::ProtocolFees
    };
    env.storage().instance().set(&key, &remaining);
    let recipient = if ecosystem {
        config.ecosystem_fee_recipient.clone()
    } else {
        config.protocol_fee_recipient.clone()
    };
    token_client(env, &config).transfer(&env.current_contract_address(), &recipient, &amount);
    env.events().publish(
        (
            symbol_short!("treasury"),
            if ecosystem {
                symbol_short!("eco_fee")
            } else {
                symbol_short!("prot_fee")
            },
        ),
        (id.clone(), recipient, amount, remaining),
    );
    remaining
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
    env.storage().instance().set(
        &DataKey::LockedEscrow,
        &checked_sub(env, locked, game.escrow),
    );
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
        admin.require_auth();
        if admin != treasury
            || admin != Address::from_string(&soroban_sdk::String::from_str(&env, DESIGNATED_ADMIN))
        {
            panic_with_error!(&env, Error::Unauthorized);
        }
        if fee_bps != DEFAULT_FEE_BPS {
            panic_with_error!(&env, Error::InvalidFee);
        }
        validate_limits(&env, max_entry, max_payout, min_treasury_balance);
        if token::Client::new(&env, &token).decimals() != 7 {
            panic_with_error!(&env, Error::InvalidToken);
        }
        let mainnet_id: BytesN<32> = env
            .crypto()
            .sha256(&Bytes::from_slice(
                &env,
                b"Public Global Stellar Network ; September 2015",
            ))
            .into();
        let testnet_id: BytesN<32> = env
            .crypto()
            .sha256(&Bytes::from_slice(
                &env,
                b"Test SDF Network ; September 2015",
            ))
            .into();
        let expected_mainnet =
            Address::from_string(&soroban_sdk::String::from_str(&env, MAINNET_USDC));
        if env.ledger().network_id() == mainnet_id && token != expected_mainnet {
            panic_with_error!(&env, Error::InvalidToken);
        }
        if env.ledger().network_id() == testnet_id
            && token != Address::from_string(&soroban_sdk::String::from_str(&env, TESTNET_USDC))
            && token != Address::from_string(&soroban_sdk::String::from_str(&env, TESTNET_XLM))
        {
            panic_with_error!(&env, Error::InvalidToken);
        }
        let config = Config {
            admin: admin.clone(),
            treasury,
            protocol_fee_recipient: admin.clone(),
            ecosystem_fee_recipient: admin.clone(),
            ecosystem_beneficiary: admin,
            token,
            fee_bps,
            protocol_fee_bps: fee_bps / 2,
            ecosystem_fee_bps: fee_bps - fee_bps / 2,
            paused: false,
            bot_enabled: true,
            max_entry,
            max_payout,
            min_treasury_balance,
        };
        write_config(&env, &config);
        env.storage().instance().set(&DataKey::BotPool, &0_i128);
        env.storage()
            .instance()
            .set(&DataKey::ProtocolFees, &0_i128);
        env.storage()
            .instance()
            .set(&DataKey::EcosystemFees, &0_i128);
        env.storage()
            .instance()
            .set(&DataKey::LockedEscrow, &0_i128);
        write_stats(&env, &read_stats(&env));
    }

    // ---------------------------------------------------------------- reads

    pub fn get_config(env: Env) -> Config {
        read_config(&env)
    }

    pub fn get_rules_hash(env: Env) -> BytesN<32> {
        rules_hash(&env)
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

    pub fn get_protocol_fees(env: Env) -> i128 {
        protocol_fees(&env)
    }

    pub fn get_ecosystem_fees(env: Env) -> i128 {
        ecosystem_fees(&env)
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
        input_key: BytesN<32>,
        input_key_proof: BytesN<64>,
    ) -> Game {
        creator.require_auth();
        let config = read_config(&env);
        // Bind public game IDs to app-authorized players. The player's own
        // signature remains mandatory; the existing administrator co-signs.
        config.admin.require_auth();
        verify_enrollment(&env, &id, &creator, 1, &input_key, &input_key_proof);
        if config.paused {
            panic_with_error!(&env, Error::Paused);
        }
        if entry_amount < MIN_ENTRY || entry_amount > MAX_ENTRY || entry_amount > config.max_entry {
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
            if checked_sub(&env, pool, entry_amount) < config.min_treasury_balance {
                panic_with_error!(&env, Error::BelowMinTreasury);
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
            protocol_fee_bps: config.protocol_fee_bps,
            ecosystem_fee_bps: config.ecosystem_fee_bps,
            max_payout: config.max_payout,
            status: STATUS_WAITING,
            winner: None,
            player_one_score: 0,
            player_two_score: 0,
            player_one_combo: 0,
            player_two_combo: 0,
            created_ledger: now,
            expiry_ledger,
            settled_ledger: 0,
            escrow,
            payout: 0,
            fee: 0,
            protocol_fee: 0,
            ecosystem_fee: 0,
            result_hash: BytesN::from_array(&env, &[0u8; 32]),
            verification_version: RULES_VERSION,
            seed: BytesN::from_array(&env, &[0; 32]),
            started_at_ms: 0,
            started_ledger: 0,
            play_start_ms: 0,
            end_at_ms: 0,
            input_deadline_ms: 0,
            inputs_one: PlayerInputs::new(&env, input_key),
            inputs_two: PlayerInputs::new(&env, BytesN::from_array(&env, &[0; 32])),
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
    pub fn join_game(
        env: Env,
        player: Address,
        id: BytesN<32>,
        input_key: BytesN<32>,
        input_key_proof: BytesN<64>,
    ) -> Game {
        player.require_auth();
        let config = read_config(&env);
        config.admin.require_auth();
        verify_enrollment(&env, &id, &player, 2, &input_key, &input_key_proof);
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
        game.inputs_two = PlayerInputs::new(&env, input_key);
        game.status = STATUS_JOINED;
        game.escrow = checked_add(&env, game.escrow, game.entry_amount);
        write_game(&env, &game);

        let locked = locked_escrow(&env);
        env.storage().instance().set(
            &DataKey::LockedEscrow,
            &checked_add(&env, locked, game.entry_amount),
        );
        let mut stats = read_stats(&env);
        stats.volume = checked_add(&env, stats.volume, game.entry_amount);
        write_stats(&env, &stats);

        env.events().publish(
            (symbol_short!("game"), symbol_short!("join")),
            (id, player, game.escrow),
        );
        game
    }

    /// Anyone can start a funded, joined game; ledger time and host randomness
    /// establish its immutable play clock and seed. No external seed/result.
    pub fn start_game(env: Env, id: BytesN<32>) -> Game {
        let mut game = read_game(&env, &id);
        let ready = game.status == STATUS_JOINED
            || (game.mode == MODE_BOT && game.status == STATUS_WAITING);
        if !ready {
            panic_with_error!(&env, Error::GameNotJoined);
        }
        if env.ledger().sequence() >= game.expiry_ledger {
            panic_with_error!(&env, Error::GameExpired);
        }
        game.status = STATUS_ACTIVE;
        game.seed = BytesN::from_array(&env, &env.prng().gen::<[u8; 32]>());
        game.started_at_ms = add_time(&env, clock_ms(&env), START_CONFIRMATION_BUFFER_MS);
        game.started_ledger = env.ledger().sequence();
        game.play_start_ms = add_time(&env, game.started_at_ms, u64::from(COUNTDOWN_MS));
        game.end_at_ms = add_time(&env, game.play_start_ms, u64::from(GAME_DURATION_MS));
        game.input_deadline_ms = add_time(
            &env,
            game.started_at_ms,
            u64::from(GAME_DURATION_MS + ABANDONMENT_WINDOW_MS),
        );
        write_game(&env, &game);
        env.events()
            .publish((symbol_short!("game"), symbol_short!("start")), id);
        game
    }

    /// A fee sponsor may relay these bytes, but only the participant's registered
    /// input key can authorize them. The contract replays every legal transition.
    pub fn submit_inputs(
        env: Env,
        id: BytesN<32>,
        player: Address,
        sequence: u32,
        closed: bool,
        transcript: Bytes,
        signature: BytesN<64>,
    ) -> Game {
        let mut game = read_game(&env, &id);
        if game.status != STATUS_ACTIVE {
            panic_with_error!(&env, Error::GameNotActive);
        }
        let now = clock_ms(&env);
        if now < game.play_start_ms {
            panic_with_error!(&env, Error::GameNotActive);
        }
        if now > game.input_deadline_ms {
            panic_with_error!(&env, Error::InputDeadline);
        }
        if transcript.len() as usize > MAX_TRANSCRIPT_BYTES || (transcript.is_empty() && !closed) {
            panic_with_error!(&env, Error::InvalidTranscript);
        }
        let seat = if player == game.creator {
            1
        } else if game.mode == MODE_PVP && game.opponent.as_ref() == Some(&player) {
            2
        } else {
            panic_with_error!(&env, Error::Unauthorized);
        };
        let mut inputs = if seat == 1 {
            game.inputs_one.clone()
        } else {
            game.inputs_two.clone()
        };
        if inputs.closed {
            panic_with_error!(&env, Error::InputClosed);
        }
        if sequence != inputs.state.events {
            panic_with_error!(&env, Error::InvalidSequence);
        }
        let message = input_message(
            &env,
            &id,
            &game.seed,
            &player,
            seat,
            &inputs,
            sequence,
            closed,
            game.started_at_ms,
            game.input_deadline_ms,
            &transcript,
        );
        env.crypto()
            .ed25519_verify(&inputs.public_key, &message, &signature);
        let mut bytes = [0_u8; MAX_TRANSCRIPT_BYTES];
        transcript.copy_into_slice(&mut bytes[..transcript.len() as usize]);
        let seed = hex_seed(&game.seed);
        let seed = core::str::from_utf8(&seed).unwrap();
        let schedule = build_schedule(seed, GAME_DURATION_MS)
            .unwrap_or_else(|_| panic_with_error!(&env, Error::InvalidTranscript));
        let mut session = Session::from_checkpoint(&inputs.state);
        session
            .apply_transcript(
                &schedule,
                GAME_DURATION_MS,
                &bytes[..transcript.len() as usize],
            )
            .unwrap_or_else(|_| panic_with_error!(&env, Error::InvalidTranscript));
        if session.previous_at.map(u64::from).unwrap_or(0) > now - game.play_start_ms {
            panic_with_error!(&env, Error::FutureInput);
        }
        inputs.state = session.checkpoint(&env);
        inputs.commitment = env.crypto().sha256(&message).into();
        inputs.closed = closed;
        if seat == 1 {
            game.inputs_one = inputs;
        } else {
            game.inputs_two = inputs;
        }
        write_game(&env, &game);
        env.events().publish(
            (symbol_short!("game"), symbol_short!("inputs")),
            (id, player, sequence, closed),
        );
        game
    }

    /// Player-controlled recovery rotates only that player's credential. It
    /// cannot rewrite accepted inputs, scores, commitments or another seat.
    pub fn rotate_input_key(
        env: Env,
        id: BytesN<32>,
        player: Address,
        input_key: BytesN<32>,
        input_key_proof: BytesN<64>,
    ) -> Game {
        player.require_auth();
        let mut game = read_game(&env, &id);
        if !matches!(game.status, STATUS_WAITING | STATUS_JOINED | STATUS_ACTIVE) {
            panic_with_error!(&env, Error::InvalidStatus);
        }
        if game.status == STATUS_ACTIVE && clock_ms(&env) > game.input_deadline_ms {
            panic_with_error!(&env, Error::InputDeadline);
        }
        let seat = if player == game.creator {
            1
        } else if game.mode == MODE_PVP && game.opponent.as_ref() == Some(&player) {
            2
        } else {
            panic_with_error!(&env, Error::Unauthorized);
        };
        verify_enrollment(&env, &id, &player, seat, &input_key, &input_key_proof);
        let mut inputs = if seat == 1 {
            game.inputs_one.clone()
        } else {
            game.inputs_two.clone()
        };
        if inputs.closed {
            panic_with_error!(&env, Error::InputClosed);
        }
        inputs.key_epoch = inputs
            .key_epoch
            .checked_add(1)
            .unwrap_or_else(|| panic_with_error!(&env, Error::Overflow));
        inputs.public_key = input_key;
        if seat == 1 {
            game.inputs_one = inputs;
        } else {
            game.inputs_two = inputs;
        }
        write_game(&env, &game);
        game
    }

    /// Anyone can request completion after the ledger clock and input deadline
    /// permit it. Winner, bot result, fees and payout are exclusively internal.
    pub fn settle_game(env: Env, id: BytesN<32>) -> Game {
        let config = read_config(&env);
        let mut game = read_game(&env, &id);

        if matches!(
            game.status,
            STATUS_SETTLED | STATUS_CANCELLED | STATUS_EXPIRED
        ) {
            panic_with_error!(&env, Error::GameAlreadySettled);
        }
        if game.status != STATUS_ACTIVE {
            panic_with_error!(&env, Error::InvalidStatus);
        }
        let now = clock_ms(&env);
        if now < game.end_at_ms {
            panic_with_error!(&env, Error::MatchNotEnded);
        }
        let all_closed =
            game.inputs_one.closed && (game.mode == MODE_BOT || game.inputs_two.closed);
        if !all_closed && now <= game.input_deadline_ms {
            panic_with_error!(&env, Error::InputsPending);
        }
        let player_one_score = game.inputs_one.state.score.score;
        let player_one_combo = i64::from(game.inputs_one.state.score.max_combo);
        let second = if game.mode == MODE_BOT {
            let seed = hex_seed(&game.seed);
            let seed = core::str::from_utf8(&seed).unwrap();
            let schedule = build_schedule(seed, GAME_DURATION_MS)
                .unwrap_or_else(|_| panic_with_error!(&env, Error::InvalidTranscript));
            bot_score(seed, GAME_DURATION_MS, &schedule)
                .unwrap_or_else(|_| panic_with_error!(&env, Error::InvalidTranscript))
        } else {
            game.inputs_two.state.score.clone()
        };
        let player_two_score = second.score;
        let player_two_combo = i64::from(second.max_combo);
        // Preserve score, then max-combo, then the existing seat-1 tie break.
        let creator_won = player_one_score > player_two_score
            || (player_one_score == player_two_score && player_one_combo >= player_two_combo);
        let winner = if creator_won {
            game.creator.clone()
        } else if game.mode == MODE_BOT {
            config.treasury.clone()
        } else {
            game.opponent
                .clone()
                .unwrap_or_else(|| panic_with_error!(&env, Error::InvalidWinner))
        };
        let mut result = Bytes::from_slice(&env, b"ChainDuel:Pulse:Result:v1\0");
        result.append(&id.clone().into());
        result.append(&game.seed.clone().into());
        result.append(&game.inputs_one.commitment.clone().into());
        result.append(&game.inputs_two.commitment.clone().into());
        result.append(&Bytes::from_array(&env, &player_one_score.to_be_bytes()));
        result.append(&Bytes::from_array(&env, &player_two_score.to_be_bytes()));
        result.append(&Bytes::from_array(&env, &player_one_combo.to_be_bytes()));
        result.append(&Bytes::from_array(&env, &player_two_combo.to_be_bytes()));
        let result_hash: BytesN<32> = env.crypto().sha256(&result).into();

        let pool = game.escrow;
        let (payout, protocol, ecosystem) =
            split_pool(&env, pool, game.protocol_fee_bps, game.ecosystem_fee_bps);
        let fee = checked_add(&env, protocol, ecosystem);
        if payout > game.max_payout {
            panic_with_error!(&env, Error::ExceedsMaxPayout);
        }

        let client = token_client(&env, &config);
        let contract = env.current_contract_address();
        game.winner = Some(winner.clone());
        game.player_one_score = player_one_score;
        game.player_two_score = player_two_score;
        game.player_one_combo = player_one_combo;
        game.player_two_combo = player_two_combo;
        game.status = STATUS_SETTLED;
        game.settled_ledger = env.ledger().sequence();
        game.payout = payout;
        game.fee = fee;
        game.protocol_fee = protocol;
        game.ecosystem_fee = ecosystem;
        game.result_hash = result_hash;
        write_game(&env, &game);

        let locked = locked_escrow(&env);
        env.storage()
            .instance()
            .set(&DataKey::LockedEscrow, &checked_sub(&env, locked, pool));

        env.storage().instance().set(
            &DataKey::ProtocolFees,
            &checked_add(&env, protocol_fees(&env), protocol),
        );
        env.storage().instance().set(
            &DataKey::EcosystemFees,
            &checked_add(&env, ecosystem_fees(&env), ecosystem),
        );

        let mut stats = read_stats(&env);
        stats.games_settled += 1;
        stats.fees_collected = checked_add(&env, stats.fees_collected, fee);
        stats.protocol_fees_collected = checked_add(&env, stats.protocol_fees_collected, protocol);
        stats.ecosystem_fees_collected =
            checked_add(&env, stats.ecosystem_fees_collected, ecosystem);
        stats.payout_total = checked_add(&env, stats.payout_total, payout);
        if game.mode == MODE_BOT {
            if !creator_won {
                stats.bot_wins += 1;
            } else {
                stats.player_wins += 1;
                stats.bot_payouts = checked_add(&env, stats.bot_payouts, payout);
            }
        }
        write_stats(&env, &stats);

        // State effects precede the token interaction; any transfer failure
        // rolls the entire transaction back, including both fee buckets.
        client.transfer(&contract, &winner, &payout);

        env.events().publish(
            (symbol_short!("game"), symbol_short!("settle")),
            (id, winner, payout, protocol, ecosystem),
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
        extend_instance(&env);
        env.events().publish(
            (symbol_short!("treasury"), symbol_short!("fund")),
            (from, amount),
        );
    }

    /// Each independently accounted bucket has the same exclusive collector.
    /// A withdrawal ID is consumed atomically so an intent cannot execute twice.
    pub fn withdraw_protocol_fees(env: Env, withdrawal_id: BytesN<32>, amount: i128) -> i128 {
        withdraw_fees(&env, false, amount, &withdrawal_id)
    }

    pub fn withdraw_ecosystem_fees(env: Env, withdrawal_id: BytesN<32>, amount: i128) -> i128 {
        withdraw_fees(&env, true, amount, &withdrawal_id)
    }

    /// Moves unallocated bot liquidity back to the treasury wallet.
    pub fn withdraw_bot_liquidity(env: Env, amount: i128, withdrawal_id: BytesN<32>) -> i128 {
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let config = read_config(&env);
        config.treasury.require_auth();
        require_solvency(&env, &config);
        let pool = bot_pool(&env);
        if amount > pool {
            panic_with_error!(&env, Error::InsufficientBotLiquidity);
        }
        let remaining = checked_sub(&env, pool, amount);
        if remaining < config.min_treasury_balance {
            panic_with_error!(&env, Error::BelowMinTreasury);
        }
        claim_withdrawal(&env, &withdrawal_id);
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
        if fee_bps != DEFAULT_FEE_BPS {
            panic_with_error!(&env, Error::InvalidFee);
        }
        let mut config = read_config(&env);
        config.fee_bps = fee_bps;
        config.protocol_fee_bps = fee_bps / 2;
        config.ecosystem_fee_bps = fee_bps - fee_bps / 2;
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

    // Admin, treasury, fee recipients and token are immutable. There is no
    // upgrade, arbitrary token-transfer or role-rotation entry point.

    pub fn set_limits(
        env: Env,
        max_entry: i128,
        max_payout: i128,
        min_treasury_balance: i128,
    ) -> Config {
        require_admin(&env);
        validate_limits(&env, max_entry, max_payout, min_treasury_balance);
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
