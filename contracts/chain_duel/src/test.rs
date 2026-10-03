use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token, xdr::ScVal, Address, BytesN, Env, IntoVal, TryFromVal,
};

/// Pins the numeric ABI that `src/lib/stellar/contract.ts` encodes. If these
/// constants change, the TypeScript client must change with them.
#[test]
fn abi_constants_match_the_typescript_client() {
    let env = Env::default();
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

const XLM: i128 = 10_000_000;
const ENTRY: i128 = 5 * XLM;
const FEE_BPS: u32 = 1_000;

fn game_id(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

fn result_hash(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[9u8; 32])
}

/// Registers the token + contract and funds the players. Auth is mocked.
fn world() -> (Env, Address, Address, Address, Address, Address) {
    let env = Env::default();
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
            100 * XLM,
            1_000 * XLM,
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
    assert_eq!(asset.balance(&p1), 995 * XLM);

    let joined = client.join_game(&p2, &game_id(&env, 1));
    assert_eq!(joined.status, STATUS_JOINED);
    assert_eq!(joined.escrow, 2 * ENTRY);
    assert_eq!(asset.balance(&contract), 2 * ENTRY);

    let started = client.start_game(&game_id(&env, 1));
    assert_eq!(started.status, STATUS_ACTIVE);

    let settled = client.settle_game(&game_id(&env, 1), &p1, &120, &80, &result_hash(&env));
    assert_eq!(settled.status, STATUS_SETTLED);
    assert_eq!(settled.winner, Some(p1.clone()));

    // 10 XLM pool, 10% fee => 9 XLM to the winner, 1 XLM protocol revenue.
    assert_eq!(settled.payout, 9 * XLM);
    assert_eq!(settled.fee, XLM);
    assert_eq!(asset.balance(&p1), 1_004 * XLM);
    assert_eq!(asset.balance(&p2), 995 * XLM);
    assert_eq!(client.get_accrued_fees(), XLM);
    assert_eq!(client.get_locked_escrow(), 0);
    assert_eq!(asset.balance(&contract), XLM);

    let stats = client.get_stats();
    assert_eq!(stats.games_created, 1);
    assert_eq!(stats.games_settled, 1);
    assert_eq!(stats.fees_collected, XLM);
    assert_eq!(stats.payout_total, 9 * XLM);
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
        .try_create_game(&p1, &game_id(&env, 5), &MODE_PVP, &(1_000 * XLM), &500)
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
    assert_eq!(client.get_bot_liquidity(), 45 * XLM);
    // 45 XLM of idle bot liquidity + 10 XLM of live escrow are both inside the contract.
    assert_eq!(asset.balance(&contract), 55 * XLM);
    assert_eq!(
        asset.balance(&contract),
        client.get_bot_liquidity() + client.get_locked_escrow() + client.get_accrued_fees()
    );
    client.start_game(&game_id(&env, 20));

    let settled = client.settle_game(&game_id(&env, 20), &admin, &40, &90, &result_hash(&env));
    assert_eq!(settled.status, STATUS_SETTLED);
    assert_eq!(settled.payout, 9 * XLM);
    // Protocol staked 5, won the 9 XLM pot back, and owns the 1 XLM fee.
    assert_eq!(client.get_accrued_fees(), XLM);
    assert_eq!(asset.balance(&p1), 995 * XLM);
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

    assert_eq!(asset.balance(&p1), 1_004 * XLM);
    assert_eq!(client.get_stats().player_wins, 1);
    assert_eq!(client.get_stats().bot_payouts, 9 * XLM);
    assert_eq!(client.get_bot_liquidity(), 45 * XLM);
    assert_eq!(client.get_accrued_fees(), XLM);
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
    fund_bot_pool(&env, &client, &admin, 20 * XLM);

    client.create_game(&p1, &game_id(&env, 23), &MODE_BOT, &ENTRY, &500);
    assert_eq!(client.get_bot_liquidity(), 15 * XLM);
    client.cancel_game(&p1, &game_id(&env, 23));
    assert_eq!(client.get_bot_liquidity(), 20 * XLM);
    assert_eq!(asset.balance(&p1), 1_000 * XLM);
    assert_eq!(asset.balance(&contract), 20 * XLM);
}

// ---------------------------------------------------------------- treasury

#[test]
fn only_the_admin_wallet_can_withdraw_treasury() {
    let env = Env::default();
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
    assert_eq!(client.get_accrued_fees(), XLM);

    let remaining = client.withdraw_treasury(&XLM);
    assert_eq!(remaining, 0);
    let asset = token::Client::new(&env, &token);
    // 1000 minted - 20 bot liquidity funded - 5 entry staked in the duel + 1 XLM withdrawn fee.
    assert_eq!(asset.balance(&admin), 976 * XLM);
    assert!(client.try_withdraw_treasury(&XLM).is_err());
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
    client.fund_bot_pool(&admin, &(100 * XLM));

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
