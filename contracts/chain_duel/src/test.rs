use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token, xdr::ScVal, Address, BytesN, Env, IntoVal, TryFromVal,
};

/// Pins the numeric ABI that `src/lib/stellar/contract.ts` encodes. If these
/// constants change, the TypeScript client must change with them.
#[test]
fn abi_constants_match_the_typescript_client() {
    let env = test_env();
    assert_eq!(MODE_PVP, 0);
    assert_eq!(MODE_BOT, 1);
    assert_eq!(STATUS_WAITING, 0);
    assert_eq!(STATUS_JOINED, 1);
    assert_eq!(STATUS_ACTIVE, 2);
    assert_eq!(STATUS_FINISHED, 3);
    assert_eq!(STATUS_SETTLED, 4);
    assert_eq!(STATUS_CANCELLED, 5);
    assert_eq!(STATUS_EXPIRED, 6);
    assert_eq!(DEFAULT_FEE_BPS, 1_000);
    assert_eq!(BPS_DENOMINATOR, 10_000);
    assert_eq!(MAX_FEE_BPS, 3_000);

    let mode_val: soroban_sdk::Val = MODE_BOT.into_val(&env);
    let mode: ScVal = ScVal::try_from_val(&env, &mode_val).unwrap();
    assert_eq!(mode, ScVal::U32(1));
    let status_val: soroban_sdk::Val = STATUS_ACTIVE.into_val(&env);
    let status: ScVal = ScVal::try_from_val(&env, &status_val).unwrap();
    assert_eq!(status, ScVal::U32(2));
}

fn test_env() -> Env {
    let mut env = Env::default();
    env.set_config(soroban_sdk::testutils::EnvTestConfig { capture_snapshot_at_drop: false });
    env
}

const XLM: i128 = 10_000_000;
const ENTRY: i128 = 25 * XLM;
const FEE_BPS: u32 = 1_000;

#[test]
fn every_entry_boundary_and_preset_escrows_and_settles_exactly() {
    for (index, entry) in [25 * XLM, 50 * XLM, 100 * XLM, 200 * XLM, 500 * XLM, 1_000 * XLM, 2_000 * XLM, 5_000 * XLM, 10_000 * XLM, 125 * XLM + 1_234_567].iter().enumerate() {
        let (env, contract, token, admin, p1, p2) = world();
        let client = ChainDuelClient::new(&env, &contract);
        let asset_admin = token::StellarAssetClient::new(&env, &token);
        asset_admin.mint(&p1, &(20_000 * XLM));
        asset_admin.mint(&p2, &(20_000 * XLM));
        asset_admin.mint(&admin, &(20_000 * XLM));
        let balances = token::Client::new(&env, &token);
        let before = balances.balance(&p1);
        let id = game_id(&env, index as u8);
        let created = client.create_game(&p1, &id, &MODE_PVP, entry, &500);
        assert_eq!(created.entry_amount, *entry);
        assert_eq!(balances.balance(&p1), before - entry);
        let joined = client.join_game(&p2, &id);
        assert_eq!(joined.escrow, entry * 2);
        client.start_game(&id);
        let settled = client.settle_game(&id, &p1, &90, &10, &result_hash(&env));
        assert_eq!(settled.fee, entry * 2 / 10);
        assert_eq!(settled.payout, entry * 2 - settled.fee);
        assert_eq!(balances.balance(&p1), before - entry + settled.payout);
        assert_eq!(client.get_locked_escrow(), 0);
        assert_eq!(balances.balance(&contract), settled.fee);

        // The computer contributes exactly the same entry and can settle the maximum.
        client.fund_bot_pool(&admin, entry);
        let bot_id = game_id(&env, 100 + index as u8);
        let bot = client.create_game(&p1, &bot_id, &MODE_BOT, entry, &500);
        assert_eq!(bot.bot_stake, *entry);
        assert_eq!(bot.escrow, entry * 2);
        client.start_game(&bot_id);
        let settled_bot = client.settle_game(&bot_id, &p1, &90, &10, &result_hash(&env));
        assert_eq!(settled_bot.payout, settled.payout);
    }
}

#[test]
fn hard_entry_limits_cannot_be_relaxed_by_admin_configuration() {
    let (env, contract, token, _admin, p1, _p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    client.set_limits(&(MAX_ENTRY * 10), &(MAX_ENTRY * 20), &0);
    let balances = token::Client::new(&env, &token);
    let before = balances.balance(&p1);
    for (index, entry) in [0, -1, MIN_ENTRY - 1, MAX_ENTRY + 1].iter().enumerate() {
        for mode in [MODE_PVP, MODE_BOT] {
            assert!(client.try_create_game(&p1, &game_id(&env, index as u8), &mode, entry, &500).is_err());
            assert_eq!(balances.balance(&p1), before);
            assert_eq!(client.get_locked_escrow(), 0);
        }
    }
}

fn game_id(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

fn result_hash(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[9u8; 32])
}

/// Registers the token + contract and funds the players. Auth is mocked.
fn world() -> (Env, Address, Address, Address, Address, Address) {
    let env = test_env();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.sequence_number = 100);

    let admin = Address::generate(&env);
    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = sac.address();
    let asset = token::StellarAssetClient::new(&env, &token);
    asset.mint(&p1, &(1_000 * XLM));
    asset.mint(&p2, &(1_000 * XLM));
    asset.mint(&admin, &(1_000 * XLM));

    let contract = env.register(
        ChainDuel,
        (
            admin.clone(),
            admin.clone(),
            token.clone(),
            FEE_BPS,
            MAX_ENTRY,
            2 * MAX_ENTRY,
            10 * XLM,
        ),
    );
    (env, contract, token, admin, p1, p2)
}

#[test]
fn config_is_initialized_with_defaults() {
    let (env, contract, token, admin, _p1, _p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    let config = client.get_config();
    assert_eq!(config.admin, admin);
    assert_eq!(config.treasury, admin);
    assert_eq!(config.token, token);
    assert_eq!(config.fee_bps, FEE_BPS);
    assert!(!config.paused);
    assert!(config.bot_enabled);
    assert_eq!(client.get_bot_liquidity(), 0);
    assert_eq!(client.get_accrued_fees(), 0);
    assert_eq!(client.get_locked_escrow(), 0);
}

#[test]
fn pvp_create_join_settle_pays_winner_and_accrues_fee() {
    let (env, contract, token, _admin, p1, p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    let asset = token::Client::new(&env, &token);

    let game = client.create_game(&p1, &game_id(&env, 1), &MODE_PVP, &ENTRY, &500);
    assert_eq!(game.status, STATUS_WAITING);
    assert_eq!(game.escrow, ENTRY);
    assert_eq!(asset.balance(&contract), ENTRY);
    assert_eq!(asset.balance(&p1), 975 * XLM);

    let joined = client.join_game(&p2, &game_id(&env, 1));
    assert_eq!(joined.status, STATUS_JOINED);
    assert_eq!(joined.escrow, 2 * ENTRY);
    assert_eq!(asset.balance(&contract), 2 * ENTRY);

    let started = client.start_game(&game_id(&env, 1));
    assert_eq!(started.status, STATUS_ACTIVE);

    let settled = client.settle_game(&game_id(&env, 1), &p1, &120, &80, &result_hash(&env));
    assert_eq!(settled.status, STATUS_SETTLED);
    assert_eq!(settled.winner, Some(p1.clone()));

    // 50 XLM pool, 10% fee => 45 XLM to the winner, 5 XLM protocol revenue.
    assert_eq!(settled.payout, 45 * XLM);
    assert_eq!(settled.fee, 5 * XLM);
    assert_eq!(asset.balance(&p1), 1_020 * XLM);
    assert_eq!(asset.balance(&p2), 975 * XLM);
    assert_eq!(client.get_accrued_fees(), 5 * XLM);
    assert_eq!(client.get_locked_escrow(), 0);
    assert_eq!(asset.balance(&contract), 5 * XLM);

    let stats = client.get_stats();
    assert_eq!(stats.games_created, 1);
    assert_eq!(stats.games_settled, 1);
    assert_eq!(stats.fees_collected, 5 * XLM);
    assert_eq!(stats.payout_total, 45 * XLM);
}

#[test]
fn duplicate_settlement_is_rejected() {
    let (env, contract, _token, _admin, p1, p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    client.create_game(&p1, &game_id(&env, 2), &MODE_PVP, &ENTRY, &500);
    client.join_game(&p2, &game_id(&env, 2));
    client.start_game(&game_id(&env, 2));
    client.settle_game(&game_id(&env, 2), &p1, &10, &5, &result_hash(&env));

    let second = client.try_settle_game(&game_id(&env, 2), &p2, &5, &10, &result_hash(&env));
    assert!(second.is_err());
}

#[test]
fn cannot_join_twice_or_join_as_creator() {
    let (env, contract, _token, _admin, p1, p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    client.create_game(&p1, &game_id(&env, 3), &MODE_PVP, &ENTRY, &500);

    assert!(client
        .try_join_game(&p1, &game_id(&env, 3))
        .is_err());
    client.join_game(&p2, &game_id(&env, 3));
    assert!(client
        .try_join_game(&p2, &game_id(&env, 3))
        .is_err());
}

#[test]
fn wrong_amount_and_unknown_game_are_rejected() {
    let (env, contract, _token, _admin, p1, _p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    assert!(client
        .try_create_game(&p1, &game_id(&env, 4), &MODE_PVP, &0, &500)
        .is_err());
    assert!(client
        .try_create_game(&p1, &game_id(&env, 5), &MODE_PVP, &(10_001 * XLM), &500)
        .is_err());
    assert!(client.try_get_game(&game_id(&env, 250)).is_err());
    assert!(client
        .try_settle_game(&game_id(&env, 250), &p1, &0, &0, &result_hash(&env))
        .is_err());
}

#[test]
fn creator_can_cancel_and_get_a_full_refund() {
    let (env, contract, token, _admin, p1, _p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    let asset = token::Client::new(&env, &token);

    client.create_game(&p1, &game_id(&env, 6), &MODE_PVP, &ENTRY, &500);
    let cancelled = client.cancel_game(&p1, &game_id(&env, 6));
    assert_eq!(cancelled.status, STATUS_CANCELLED);
    assert_eq!(asset.balance(&p1), 1_000 * XLM);
    assert_eq!(asset.balance(&contract), 0);
    assert_eq!(client.get_locked_escrow(), 0);
    assert!(client.try_cancel_game(&p1, &game_id(&env, 6)).is_err());
}

#[test]
fn any_player_can_claim_a_refund_after_expiry() {
    let (env, contract, token, _admin, p1, p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    let asset = token::Client::new(&env, &token);

    client.create_game(&p1, &game_id(&env, 7), &MODE_PVP, &ENTRY, &150);
    client.join_game(&p2, &game_id(&env, 7));
    assert!(client.try_claim_refund(&game_id(&env, 7)).is_err());

    env.ledger().with_mut(|l| l.sequence_number = 500);
    let expired = client.claim_refund(&game_id(&env, 7));
    assert_eq!(expired.status, STATUS_EXPIRED);
    assert_eq!(asset.balance(&p1), 1_000 * XLM);
    assert_eq!(asset.balance(&p2), 1_000 * XLM);
    assert_eq!(client.get_locked_escrow(), 0);
}

#[test]
fn expired_duel_cannot_be_joined() {
    let (env, contract, _token, _admin, p1, p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    client.create_game(&p1, &game_id(&env, 8), &MODE_PVP, &ENTRY, &120);
    env.ledger().with_mut(|l| l.sequence_number = 400);
    assert!(client.try_join_game(&p2, &game_id(&env, 8)).is_err());
}

// ------------------------------------------------------------------- bots

fn fund_bot_pool(env: &Env, client: &ChainDuelClient, admin: &Address, amount: i128) {
    client.fund_bot_pool(admin, &amount);
    let _ = env;
}

#[test]
fn bot_win_settles_into_the_protocol_treasury() {
    let (env, contract, token, admin, p1, _p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    let asset = token::Client::new(&env, &token);
    fund_bot_pool(&env, &client, &admin, 50 * XLM);
    assert_eq!(client.get_bot_liquidity(), 50 * XLM);

    client.create_game(&p1, &game_id(&env, 20), &MODE_BOT, &ENTRY, &500);
    assert_eq!(client.get_bot_liquidity(), 25 * XLM);
    // 25 XLM of idle bot liquidity + 50 XLM of live escrow are both inside the contract.
    assert_eq!(asset.balance(&contract), 75 * XLM);
    assert_eq!(
        asset.balance(&contract),
        client.get_bot_liquidity() + client.get_locked_escrow() + client.get_accrued_fees()
    );
    client.start_game(&game_id(&env, 20));

    let settled = client.settle_game(&game_id(&env, 20), &admin, &40, &90, &result_hash(&env));
    assert_eq!(settled.status, STATUS_SETTLED);
    assert_eq!(settled.payout, 45 * XLM);
    // Protocol staked 25, won the 45 XLM pot back, and owns the 5 XLM fee.
    assert_eq!(client.get_accrued_fees(), 5 * XLM);
    assert_eq!(asset.balance(&p1), 975 * XLM);
    assert_eq!(client.get_stats().bot_wins, 1);
    assert_eq!(client.get_stats().player_wins, 0);
}

#[test]
fn player_win_is_funded_from_bot_liquidity() {
    let (env, contract, token, admin, p1, _p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    let asset = token::Client::new(&env, &token);
    fund_bot_pool(&env, &client, &admin, 50 * XLM);

    client.create_game(&p1, &game_id(&env, 21), &MODE_BOT, &ENTRY, &500);
    client.start_game(&game_id(&env, 21));
    client.settle_game(&game_id(&env, 21), &p1, &95, &60, &result_hash(&env));

    assert_eq!(asset.balance(&p1), 1_020 * XLM);
    assert_eq!(client.get_stats().player_wins, 1);
    assert_eq!(client.get_stats().bot_payouts, 45 * XLM);
    assert_eq!(client.get_bot_liquidity(), 25 * XLM);
    assert_eq!(client.get_accrued_fees(), 5 * XLM);
}

#[test]
fn bot_game_without_liquidity_is_rejected() {
    let (env, contract, _token, _admin, p1, _p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    let attempt = client.try_create_game(&p1, &game_id(&env, 22), &MODE_BOT, &ENTRY, &500);
    assert!(attempt.is_err());
}

#[test]
fn bot_game_cancel_returns_liquidity_to_the_pool() {
    let (env, contract, token, admin, p1, _p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    let asset = token::Client::new(&env, &token);
    fund_bot_pool(&env, &client, &admin, 100 * XLM);

    client.create_game(&p1, &game_id(&env, 23), &MODE_BOT, &ENTRY, &500);
    assert_eq!(client.get_bot_liquidity(), 75 * XLM);
    client.cancel_game(&p1, &game_id(&env, 23));
    assert_eq!(client.get_bot_liquidity(), 100 * XLM);
    assert_eq!(asset.balance(&p1), 1_000 * XLM);
    assert_eq!(asset.balance(&contract), 100 * XLM);
}

// ---------------------------------------------------------------- treasury

#[test]
fn only_the_developer_wallet_can_withdraw_treasury() {
    let env = test_env();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.sequence_number = 100);
    let admin = Address::generate(&env);
    let player = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = sac.address();
    let asset_admin = token::StellarAssetClient::new(&env, &token);
    asset_admin.mint(&player, &(100 * XLM));
    asset_admin.mint(&admin, &(1_000 * XLM));

    let contract = env.register(
        ChainDuel,
        (admin.clone(), admin.clone(), token.clone(), FEE_BPS, 100 * XLM, 1_000 * XLM, 10 * XLM),
    );
    // Drop the blanket auth mock: from here on every call must be genuinely authorised.
    env.mock_auths(&[]);
    let client = ChainDuelClient::new(&env, &contract);

    // No auth mocked: every withdrawal attempt must fail.
    assert!(client.try_withdraw_treasury(&XLM).is_err());
    assert!(client.try_set_treasury(&player).is_err());
    assert!(client.try_set_fee_bps(&2_000).is_err());
    assert!(client.try_set_paused(&true).is_err());
    assert!(client.try_withdraw_bot_liquidity(&XLM).is_err());
    assert!(client.try_fund_bot_pool(&player, &XLM).is_err());

    // Authenticated admin flow: accrue fees, then withdraw to the bound wallet.
    env.mock_all_auths();
    client.fund_bot_pool(&admin, &(20 * XLM));
    client.create_game(&player, &game_id(&env, 30), &MODE_PVP, &ENTRY, &500);
    client.join_game(&admin, &game_id(&env, 30));
    client.start_game(&game_id(&env, 30));
    client.settle_game(&game_id(&env, 30), &player, &90, &10, &result_hash(&env));
    assert_eq!(client.get_accrued_fees(), 5 * XLM);

    let remaining = client.withdraw_treasury(&(5 * XLM));
    assert_eq!(remaining, 0);
    let asset = token::Client::new(&env, &token);
    // 1000 minted - 20 bot liquidity funded - 25 entry staked + 5 XLM withdrawn fee.
    assert_eq!(asset.balance(&admin), 960 * XLM);
    assert!(client.try_withdraw_treasury(&XLM).is_err());
}

/// Roles are deliberately split: `admin` (the server's settlement key) may
/// settle games, but it can never move treasury revenue. Only the designated
/// developer wallet can, and the funds can only land back at that wallet.
#[test]
fn withdrawal_requires_the_designated_developer_wallet_not_the_settler() {
    let env = test_env();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.sequence_number = 100);
    let settler = Address::generate(&env);
    let developer = Address::generate(&env);
    let player = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(developer.clone());
    let token = sac.address();
    let asset_admin = token::StellarAssetClient::new(&env, &token);
    asset_admin.mint(&player, &(100 * XLM));
    asset_admin.mint(&developer, &(100 * XLM));

    let contract = env.register(
        ChainDuel,
        (settler.clone(), developer.clone(), token.clone(), FEE_BPS, 100 * XLM, 1_000 * XLM, 10 * XLM),
    );
    let client = ChainDuelClient::new(&env, &contract);
    let config = client.get_config();
    assert_eq!(config.admin, settler);
    assert_eq!(config.treasury, developer);

    // Accrue a 5 XLM protocol fee from a settled duel.
    client.create_game(&player, &game_id(&env, 40), &MODE_PVP, &ENTRY, &500);
    client.join_game(&developer, &game_id(&env, 40));
    client.start_game(&game_id(&env, 40));
    client.settle_game(&game_id(&env, 40), &player, &90, &10, &result_hash(&env));
    assert_eq!(client.get_accrued_fees(), 5 * XLM);

    // Only the developer wallet authorises the withdrawal...
    assert_eq!(client.withdraw_treasury(&(5 * XLM)), 0);
    let auths = env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, developer);
    // 100 minted - 25 entry staked + 5 XLM of accrued fees withdrawn.
    let asset = token::Client::new(&env, &token);
    assert_eq!(asset.balance(&developer), 80 * XLM);

    // ...and with real auth required, the settler and a stranger both fail.
    env.mock_auths(&[]);
    assert!(client.try_withdraw_treasury(&XLM).is_err());
    assert!(client.try_withdraw_bot_liquidity(&XLM).is_err());
}

#[test]
fn set_admin_rotates_the_settler_without_moving_the_treasury() {
    let (env, contract, _token, original_admin, _p1, _p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    let next_settler = Address::generate(&env);

    let config = client.set_admin(&next_settler);
    assert_eq!(config.admin, next_settler);
    assert_eq!(config.treasury, original_admin);
    // The rotation was authorised by the original settler.
    assert_eq!(env.auths()[0].0, original_admin);

    // The retired settler no longer has any authority.
    env.mock_auths(&[]);
    assert!(client.try_set_fee_bps(&2_000).is_err());
    assert!(client.try_set_admin(&original_admin).is_err());
    env.mock_all_auths();
    assert_eq!(client.set_fee_bps(&2_000).fee_bps, 2_000);
}

#[test]
fn treasury_rotation_is_admin_only_and_leaves_the_settler_alone() {
    let (env, contract, _token, admin, _p1, _p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    let developer = Address::generate(&env);

    env.mock_auths(&[]);
    assert!(client.try_set_treasury(&developer).is_err());
    assert!(client.try_set_admin(&developer).is_err());

    env.mock_all_auths();
    let config = client.set_treasury(&developer);
    assert_eq!(config.treasury, developer);
    assert_eq!(config.admin, admin);
    assert_eq!(env.auths()[0].0, admin);
}

#[test]
fn withdrawal_cannot_touch_locked_escrow_or_bot_liquidity() {
    let (env, contract, _token, admin, p1, _p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    client.fund_bot_pool(&admin, &(10 * XLM));
    client.create_game(&p1, &game_id(&env, 31), &MODE_PVP, &ENTRY, &500);
    // Escrow is locked and there is no accrued revenue yet.
    assert!(client.try_withdraw_treasury(&(5 * XLM)).is_err());
    assert!(client.try_withdraw_bot_liquidity(&(20 * XLM)).is_err());
    assert_eq!(client.get_locked_escrow(), ENTRY);
    assert_eq!(client.get_bot_liquidity(), 10 * XLM);
}

#[test]
fn emergency_pause_blocks_new_games_but_never_traps_funds() {
    let (env, contract, token, _admin, p1, p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    client.create_game(&p1, &game_id(&env, 32), &MODE_PVP, &ENTRY, &500);
    client.set_paused(&true);
    assert!(client
        .try_create_game(&p1, &game_id(&env, 33), &MODE_PVP, &ENTRY, &500)
        .is_err());
    assert!(client.try_join_game(&p2, &game_id(&env, 32)).is_err());

    // The in-flight duel can still be cancelled and refunded while paused.
    client.cancel_game(&p1, &game_id(&env, 32));
    let asset = token::Client::new(&env, &token);
    assert_eq!(asset.balance(&p1), 1_000 * XLM);
    client.set_paused(&false);
}

#[test]
fn fee_is_capped_and_settlement_never_pays_an_outsider() {
    let (env, contract, _token, _admin, p1, p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    assert!(client.try_set_fee_bps(&5_000).is_err());
    client.create_game(&p1, &game_id(&env, 34), &MODE_PVP, &ENTRY, &500);
    client.join_game(&p2, &game_id(&env, 34));
    client.start_game(&game_id(&env, 34));
    let outsider = Address::generate(&env);
    assert!(client
        .try_settle_game(&game_id(&env, 34), &outsider, &1, &0, &result_hash(&env))
        .is_err());
}

#[test]
fn contract_balance_invariant_holds_across_a_full_bot_match() {
    let (env, contract, token, admin, p1, _p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    let asset = token::Client::new(&env, &token);
    client.fund_bot_pool(&admin, &(500 * XLM));

    for seed in 40..48u8 {
        client.create_game(&p1, &game_id(&env, seed), &MODE_BOT, &ENTRY, &9_000);
        client.start_game(&game_id(&env, seed));
        let player_wins = seed % 2 == 0;
        let winner = if player_wins { p1.clone() } else { admin.clone() };
        client.settle_game(&game_id(&env, seed), &winner, &70, &50, &result_hash(&env));
    }

    let balance = asset.balance(&contract);
    let accounted = client.get_accrued_fees() + client.get_locked_escrow() + client.get_bot_liquidity();
    assert_eq!(balance, accounted);
    assert_eq!(client.get_locked_escrow(), 0);
}
