use super::*;
extern crate std;
use ed25519_dalek::{Signer, SigningKey};
use pulse_replay::Session;
use soroban_sdk::{testutils::Ledger as _, token, xdr, IntoVal, String, TryFromVal};
use std::{rc::Rc, vec::Vec};

const UNIT: i128 = 10_000_000;
const ADMIN: &str = "GCQKVXWIQHVGUOUHZR2O6YBWBNNPKIYH5AWQHXHF3EYRHM73WIWVSK7K";
const PLAYER: &str = "GBGDTBOXVZ4GIDDRISY5FGXYY7XCWCCK3FRHJHSVFEZMWA3ZZ2HUALTK";
const OTHER: &str = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

fn address(env: &Env, value: &str) -> Address {
    Address::from_string(&String::from_str(env, value))
}
fn id(env: &Env, value: u8) -> BytesN<32> {
    BytesN::from_array(env, &[value; 32])
}

fn classic_account_with_trustline(env: &Env, who: &Address, asset: &xdr::Asset) {
    let value: soroban_sdk::Val = who.into_val(env);
    let account_id = match xdr::ScVal::try_from_val(env, &value).unwrap() {
        xdr::ScVal::Address(xdr::ScAddress::Account(account)) => account,
        _ => panic!("Expected a classic Stellar account"),
    };
    let account = xdr::AccountEntry {
        account_id: account_id.clone(),
        balance: 1000 * UNIT as i64,
        seq_num: xdr::SequenceNumber(1),
        num_sub_entries: 1,
        inflation_dest: None,
        flags: 2,
        home_domain: Default::default(),
        thresholds: xdr::Thresholds([1, 1, 1, 1]),
        signers: Default::default(),
        ext: xdr::AccountEntryExt::V0,
    };
    env.host()
        .add_ledger_entry(
            &Rc::new(xdr::LedgerKey::Account(xdr::LedgerKeyAccount {
                account_id: account_id.clone(),
            })),
            &Rc::new(xdr::LedgerEntry {
                last_modified_ledger_seq: 100,
                data: xdr::LedgerEntryData::Account(account),
                ext: xdr::LedgerEntryExt::V0,
            }),
            None,
        )
        .unwrap();
    let trust_asset = match asset {
        xdr::Asset::CreditAlphanum4(asset) => xdr::TrustLineAsset::CreditAlphanum4(asset.clone()),
        xdr::Asset::CreditAlphanum12(asset) => xdr::TrustLineAsset::CreditAlphanum12(asset.clone()),
        _ => panic!("Expected an issued asset"),
    };
    let trustline = xdr::TrustLineEntry {
        account_id: account_id.clone(),
        asset: trust_asset.clone(),
        balance: 0,
        limit: i64::MAX,
        flags: 1,
        ext: xdr::TrustLineEntryExt::V0,
    };
    env.host()
        .add_ledger_entry(
            &Rc::new(xdr::LedgerKey::Trustline(xdr::LedgerKeyTrustLine {
                account_id,
                asset: trust_asset,
            })),
            &Rc::new(xdr::LedgerEntry {
                last_modified_ledger_seq: 100,
                data: xdr::LedgerEntryData::Trustline(trustline),
                ext: xdr::LedgerEntryExt::V0,
            }),
            None,
        )
        .unwrap();
}

// Existing public addresses in a simulated host. No signing key or real wallet
// is generated. Ed25519 input credentials below are test-only and unfunded.
// No network transaction is submitted by this suite.
fn world() -> (Env, Address, Address, Address, Address, Address) {
    world_with_wasm(None)
}
fn world_with_wasm(wasm: Option<&[u8]>) -> (Env, Address, Address, Address, Address, Address) {
    let mut env = Env::default();
    env.set_config(soroban_sdk::testutils::EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.mock_all_auths();
    if wasm.is_some() {
        env.mock_all_auths_allowing_non_root_auth();
    }
    env.ledger().with_mut(|ledger| {
        ledger.sequence_number = 100;
        ledger.timestamp = 1000;
    });
    let admin = address(&env, ADMIN);
    let p1 = address(&env, PLAYER);
    let p2 = address(&env, OTHER);
    let asset = env.register_stellar_asset_contract_v2(admin.clone());
    asset
        .issuer()
        .set_flag(soroban_sdk::testutils::IssuerFlags::RevocableFlag);
    let token = asset.address();
    for who in [&admin, &p1, &p2] {
        classic_account_with_trustline(&env, who, &asset.asset());
    }
    let minter = token::StellarAssetClient::new(&env, &token);
    for who in [&admin, &p1, &p2] {
        minter.mint(who, &(50_000 * UNIT));
    }
    let constructor = (
        admin.clone(),
        admin.clone(),
        token.clone(),
        1000_u32,
        MAX_ENTRY,
        2 * MAX_ENTRY,
        100 * UNIT,
    );
    let contract = match wasm {
        Some(bytes) => env.register(bytes, constructor),
        None => env.register(ChainDuel, constructor),
    };
    (env, contract, token, admin, p1, p2)
}

#[test]
#[ignore = "Build the optimized escrow WASM first; meters the actual artifact"]
fn compiled_escrow_resources() {
    let wasm = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/target/wasm32v1-none/release/chain_duel_mainnet.wasm"
    ))
    .expect("Build escrow WASM first");
    let (env, contract, _, admin, p1, p2) = world_with_wasm(Some(&wasm));
    let client = ChainDuelClient::new(&env, &contract);
    fn cost(env: &Env, label: &str) {
        let cost = env.cost_estimate();
        std::println!(
            "ESCROW_COST label={} cpu={} memory={} fee_estimate_units={} resources={:?}",
            label,
            cost.budget().cpu_instruction_cost(),
            cost.budget().memory_bytes_cost(),
            cost.fee().total,
            cost.resources()
        );
    }
    create(&env, &contract, &p1, 1, MODE_PVP, MIN_ENTRY);
    cost(&env, "create");
    join(&env, &contract, &p2, 1);
    cost(&env, "join");
    let game = client.start_game(&id(&env, 1));
    cost(&env, "start");
    after_end(&env, &game);
    let input = Bytes::from_slice(&env, &[0; 4000 * 6]);
    let game = submit(&env, &contract, &game, &p1, 1, &input, true);
    cost(&env, "inputs_4000");
    submit(&env, &contract, &game, &p2, 2, &Bytes::new(&env), true);
    cost(&env, "inputs_empty");
    client.settle_game(&id(&env, 1));
    cost(&env, "pvp_settle");
    client.fund_bot_pool(&admin, &(200 * UNIT));
    create(&env, &contract, &p1, 2, MODE_BOT, MIN_ENTRY);
    let game = client.start_game(&id(&env, 2));
    after_end(&env, &game);
    submit(&env, &contract, &game, &p1, 1, &perfect(&env, &game), true);
    cost(&env, "inputs_realistic_perfect");
    client.settle_game(&id(&env, 2));
    cost(&env, "bot_settle");
    assert_eq!(client.get_locked_escrow(), 0);
}

fn input_key(env: &Env, key: u8) -> BytesN<32> {
    BytesN::from_array(
        env,
        &SigningKey::from_bytes(&[key; 32])
            .verifying_key()
            .to_bytes(),
    )
}
fn sign(env: &Env, key: u8, message: &Bytes) -> BytesN<64> {
    let mut bytes = std::vec![0;message.len() as usize];
    message.copy_into_slice(&mut bytes);
    BytesN::from_array(
        env,
        &SigningKey::from_bytes(&[key; 32]).sign(&bytes).to_bytes(),
    )
}
fn enrollment(
    env: &Env,
    contract: &Address,
    player: &Address,
    game_id: &BytesN<32>,
    seat: u32,
    key: u8,
) -> BytesN<64> {
    let message = env.as_contract(contract, || {
        enrollment_message(env, game_id, player, seat, &input_key(env, key))
    });
    sign(env, key, &message)
}
fn create(env: &Env, contract: &Address, player: &Address, n: u8, mode: u32, entry: i128) -> Game {
    let game_id = id(env, n);
    ChainDuelClient::new(env, contract).create_game(
        player,
        &game_id,
        &mode,
        &entry,
        &500,
        &input_key(env, 1),
        &enrollment(env, contract, player, &game_id, 1, 1),
    )
}
fn join(env: &Env, contract: &Address, player: &Address, n: u8) -> Game {
    let game_id = id(env, n);
    ChainDuelClient::new(env, contract).join_game(
        player,
        &game_id,
        &input_key(env, 2),
        &enrollment(env, contract, player, &game_id, 2, 2),
    )
}
fn pvp(env: &Env, contract: &Address, p1: &Address, p2: &Address, n: u8, entry: i128) -> Game {
    create(env, contract, p1, n, MODE_PVP, entry);
    join(env, contract, p2, n);
    ChainDuelClient::new(env, contract).start_game(&id(env, n))
}
fn events(env: &Env, entries: &[(u32, u16)]) -> Bytes {
    let mut bytes = Vec::new();
    for (at, id) in entries {
        bytes.extend_from_slice(&at.to_be_bytes());
        bytes.extend_from_slice(&id.to_be_bytes());
    }
    Bytes::from_slice(env, &bytes)
}
fn perfect(env: &Env, game: &Game) -> Bytes {
    let seed = hex_seed(&game.seed);
    let seed = core::str::from_utf8(&seed).unwrap();
    let schedule = build_schedule(seed, GAME_DURATION_MS).unwrap();
    let mut best = Session::default();
    let mut best_input = Vec::new();
    // Choose legal player inputs, never supply a winner/score to the contract.
    for offset in [70, 160, 200, 240, 400, 800, 900] {
        let input: Vec<(u32, u16)> = schedule.targets[..schedule.len]
            .iter()
            .enumerate()
            .filter(|(_, target)| target.points > 0)
            .map(|(index, target)| {
                (
                    core::cmp::min(target.spawn + offset, GAME_DURATION_MS),
                    (index + 1) as u16,
                )
            })
            .collect();
        let mut bytes = Vec::new();
        for (at, id) in &input {
            bytes.extend_from_slice(&at.to_be_bytes());
            bytes.extend_from_slice(&id.to_be_bytes());
        }
        let mut session = Session::default();
        session
            .apply_transcript(&schedule, GAME_DURATION_MS, &bytes)
            .unwrap();
        if (session.score.score, session.score.max_combo) > (best.score.score, best.score.max_combo)
        {
            best = session;
            best_input = bytes;
        }
    }
    Bytes::from_slice(env, &best_input)
}
fn packet_signature(
    env: &Env,
    contract: &Address,
    game: &Game,
    player: &Address,
    key: u8,
    sequence: u32,
    closed: bool,
    payload: &Bytes,
) -> BytesN<64> {
    let seat = if player == &game.creator { 1 } else { 2 };
    let inputs = if seat == 1 {
        &game.inputs_one
    } else {
        &game.inputs_two
    };
    let message = env.as_contract(contract, || {
        input_message(
            env,
            &game.id,
            &game.seed,
            player,
            seat,
            inputs,
            sequence,
            closed,
            game.started_at_ms,
            game.input_deadline_ms,
            payload,
        )
    });
    sign(env, key, &message)
}
fn submit(
    env: &Env,
    contract: &Address,
    game: &Game,
    player: &Address,
    key: u8,
    payload: &Bytes,
    closed: bool,
) -> Game {
    let sequence = if player == &game.creator {
        game.inputs_one.state.events
    } else {
        game.inputs_two.state.events
    };
    let proof = packet_signature(env, contract, game, player, key, sequence, closed, payload);
    ChainDuelClient::new(env, contract)
        .submit_inputs(&game.id, player, &sequence, &closed, payload, &proof)
}
fn after_end(env: &Env, game: &Game) {
    env.ledger().set_timestamp((game.end_at_ms + 999) / 1000);
}
fn after_deadline(env: &Env, game: &Game) {
    env.ledger()
        .set_timestamp(game.input_deadline_ms / 1000 + 1);
}
fn settle_p1(env: &Env, contract: &Address, p1: &Address, n: u8) -> Game {
    let client = ChainDuelClient::new(env, contract);
    let mut game = client.get_game(&id(env, n));
    after_end(env, &game);
    game = submit(env, contract, &game, p1, 1, &perfect(env, &game), true);
    if game.mode == MODE_PVP {
        let p2 = game.opponent.clone().unwrap();
        game = submit(env, contract, &game, &p2, 2, &Bytes::new(env), true);
    }
    client.settle_game(&game.id)
}

#[test]
fn all_administrative_roles_are_the_exact_designated_wallet() {
    let (env, contract, token, admin, _, _) = world();
    let client = ChainDuelClient::new(&env, &contract);
    let config = client.get_config();
    assert_eq!(config.admin, address(&env, ADMIN));
    for recipient in [
        config.treasury,
        config.protocol_fee_recipient,
        config.ecosystem_fee_recipient,
        config.ecosystem_beneficiary,
    ] {
        assert_eq!(recipient, admin);
    }
    assert_eq!(config.token, token);
    assert_eq!(
        (
            config.fee_bps,
            config.protocol_fee_bps,
            config.ecosystem_fee_bps
        ),
        (1000, 500, 500)
    );
    assert_eq!(client.get_contract_balance(), 0);
    assert_eq!(client.get_rules_hash(), rules_hash(&env));
}
#[test]
fn a_100_usdc_pot_pays_90_and_accounts_for_two_independent_fives() {
    let (env, contract, token, _, p1, p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    let balances = token::Client::new(&env, &token);
    let before = balances.balance(&p1);
    pvp(&env, &contract, &p1, &p2, 1, 50 * UNIT);
    let result = settle_p1(&env, &contract, &p1, 1);
    assert_eq!(result.winner, Some(p1.clone()));
    assert_eq!(
        (result.payout, result.protocol_fee, result.ecosystem_fee),
        (90 * UNIT, 5 * UNIT, 5 * UNIT)
    );
    assert_eq!(balances.balance(&p1), before - 50 * UNIT + 90 * UNIT);
    assert_eq!(
        (
            client.get_protocol_fees(),
            client.get_ecosystem_fees(),
            client.get_locked_escrow()
        ),
        (5 * UNIT, 5 * UNIT, 0)
    );
    assert_eq!(client.get_contract_balance(), 10 * UNIT);
}
#[test]
fn every_existing_stake_preset_and_seven_decimal_custom_amount_is_preserved() {
    let (env, contract, _, _, p1, p2) = world();
    for (index, entry) in [
        25 * UNIT,
        50 * UNIT,
        100 * UNIT,
        200 * UNIT,
        500 * UNIT,
        1000 * UNIT,
        2000 * UNIT,
        5000 * UNIT,
        10000 * UNIT,
        25 * UNIT + 1,
        10000 * UNIT - 1,
    ]
    .iter()
    .enumerate()
    {
        pvp(&env, &contract, &p1, &p2, (index + 1) as u8, *entry);
        let result = settle_p1(&env, &contract, &p1, (index + 1) as u8);
        assert_eq!(
            result.payout + result.protocol_fee + result.ecosystem_fee,
            2 * entry
        );
        assert_eq!(result.entry_amount, *entry);
    }
}
#[test]
fn invalid_entries_modes_and_input_registration_cannot_debit_any_player() {
    let (env, contract, token, _, p1, _) = world();
    let client = ChainDuelClient::new(&env, &contract);
    let before = token::Client::new(&env, &token).balance(&p1);
    let game_id = id(&env, 1);
    let proof = enrollment(&env, &contract, &p1, &game_id, 1, 1);
    for entry in [0, -1, MIN_ENTRY - 1, MAX_ENTRY + 1] {
        assert!(client
            .try_create_game(
                &p1,
                &game_id,
                &MODE_PVP,
                &entry,
                &500,
                &input_key(&env, 1),
                &proof
            )
            .is_err());
    }
    assert!(client
        .try_create_game(
            &p1,
            &game_id,
            &99,
            &MIN_ENTRY,
            &500,
            &input_key(&env, 1),
            &proof
        )
        .is_err());
    assert!(client
        .try_create_game(
            &p1,
            &game_id,
            &MODE_PVP,
            &MIN_ENTRY,
            &500,
            &input_key(&env, 2),
            &proof
        )
        .is_err());
    assert_eq!(token::Client::new(&env, &token).balance(&p1), before);
}
#[test]
fn the_90_5_5_rate_cannot_be_changed_by_a_backend_or_administrator_override() {
    let (env, contract, _, _, p1, p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    pvp(&env, &contract, &p1, &p2, 1, 50 * UNIT);
    for bps in [0, 500, 1500, 3000, 10000] {
        assert!(client.try_set_fee_bps(&bps).is_err());
    }
    client.set_fee_bps(&1000);
    let settled = settle_p1(&env, &contract, &p1, 1);
    assert_eq!(
        (settled.protocol_fee, settled.ecosystem_fee),
        (5 * UNIT, 5 * UNIT)
    );
}
#[test]
fn later_limits_cannot_freeze_a_previously_committed_player_payout() {
    let (env, contract, _, _, p1, p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    pvp(&env, &contract, &p1, &p2, 1, 50 * UNIT);
    client.set_limits(&MIN_ENTRY, &(2 * MIN_ENTRY), &(100 * UNIT));
    let game = settle_p1(&env, &contract, &p1, 1);
    assert_eq!(game.payout, 90 * UNIT);
    assert!(client
        .try_set_limits(&(MAX_ENTRY + 1), &(2 * MAX_ENTRY), &0)
        .is_err());
    assert!(client.try_set_limits(&MAX_ENTRY, &1, &0).is_err());
}
#[test]
fn every_privileged_operation_requires_actual_owner_authorization() {
    let (env, contract, _, _, _, _) = world();
    let client = ChainDuelClient::new(&env, &contract);
    env.mock_auths(&[]);
    assert!(client.try_set_paused(&true).is_err());
    assert!(client.try_set_fee_bps(&1000).is_err());
    assert!(client.try_set_bot_enabled(&false).is_err());
    assert!(client
        .try_set_limits(&MAX_ENTRY, &(2 * MAX_ENTRY), &(100 * UNIT))
        .is_err());
    assert!(client.try_withdraw_protocol_fees(&id(&env, 1), &1).is_err());
    assert!(client
        .try_withdraw_ecosystem_fees(&id(&env, 2), &1)
        .is_err());
    assert!(client.try_withdraw_bot_liquidity(&1, &id(&env, 3)).is_err());
}
#[test]
fn independent_fee_withdrawals_land_only_in_the_designated_wallet() {
    let (env, contract, token, admin, p1, p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    let balances = token::Client::new(&env, &token);
    let before = balances.balance(&admin);
    pvp(&env, &contract, &p1, &p2, 1, 50 * UNIT);
    settle_p1(&env, &contract, &p1, 1);
    client.withdraw_protocol_fees(&id(&env, 11), &(5 * UNIT));
    assert_eq!(balances.balance(&admin), before + 5 * UNIT);
    assert_eq!(client.get_ecosystem_fees(), 5 * UNIT);
    client.withdraw_ecosystem_fees(&id(&env, 12), &(5 * UNIT));
    assert_eq!(balances.balance(&admin), before + 10 * UNIT);
    assert_eq!(client.get_contract_balance(), 0);
}
#[test]
fn withdrawal_ids_cannot_be_replayed_or_reused_for_another_bucket() {
    let (env, contract, _, _, p1, p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    pvp(&env, &contract, &p1, &p2, 1, 50 * UNIT);
    settle_p1(&env, &contract, &p1, 1);
    let nonce = id(&env, 22);
    client.withdraw_protocol_fees(&nonce, &UNIT);
    assert!(client.try_withdraw_protocol_fees(&nonce, &UNIT).is_err());
    assert!(client.try_withdraw_ecosystem_fees(&nonce, &UNIT).is_err());
    assert_eq!(
        (client.get_protocol_fees(), client.get_ecosystem_fees()),
        (4 * UNIT, 5 * UNIT)
    );
}
#[test]
fn withdrawals_preserve_active_stakes_and_other_fee_buckets() {
    let (env, contract, _, admin, p1, p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    pvp(&env, &contract, &p1, &p2, 1, 50 * UNIT);
    settle_p1(&env, &contract, &p1, 1);
    pvp(&env, &contract, &p1, &p2, 2, 50 * UNIT);
    client.fund_bot_pool(&admin, &(150 * UNIT));
    assert!(client
        .try_withdraw_protocol_fees(&id(&env, 23), &(5 * UNIT + 1))
        .is_err());
    assert!(client
        .try_withdraw_ecosystem_fees(&id(&env, 24), &(5 * UNIT + 1))
        .is_err());
    assert_eq!(
        (client.get_locked_escrow(), client.get_bot_liquidity()),
        (100 * UNIT, 150 * UNIT)
    );
    client.withdraw_protocol_fees(&id(&env, 25), &(5 * UNIT));
    assert_eq!(client.get_contract_balance(), 255 * UNIT);
}
#[test]
fn duplicate_creation_join_and_settlement_cannot_move_funds_twice() {
    let (env, contract, token, _, p1, p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    create(&env, &contract, &p1, 1, MODE_PVP, 25 * UNIT);
    assert!(client
        .try_create_game(
            &p1,
            &id(&env, 1),
            &MODE_PVP,
            &MIN_ENTRY,
            &500,
            &input_key(&env, 1),
            &enrollment(&env, &contract, &p1, &id(&env, 1), 1, 1)
        )
        .is_err());
    join(&env, &contract, &p2, 1);
    assert!(client
        .try_join_game(
            &p2,
            &id(&env, 1),
            &input_key(&env, 2),
            &enrollment(&env, &contract, &p2, &id(&env, 1), 2, 2)
        )
        .is_err());
    client.start_game(&id(&env, 1));
    settle_p1(&env, &contract, &p1, 1);
    let before = token::Client::new(&env, &token).balance(&p1);
    assert!(client.try_settle_game(&id(&env, 1)).is_err());
    assert_eq!(token::Client::new(&env, &token).balance(&p1), before);
}
#[test]
fn refunds_return_only_to_depositors_and_cannot_be_claimed_twice() {
    let (env, contract, token, _, p1, p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    create(&env, &contract, &p1, 1, MODE_PVP, 25 * UNIT);
    assert!(client.try_cancel_game(&p2, &id(&env, 1)).is_err());
    client.cancel_game(&p1, &id(&env, 1));
    assert_eq!(token::Client::new(&env, &token).balance(&p1), 50000 * UNIT);
    assert!(client.try_claim_refund(&id(&env, 1)).is_err());
    create(&env, &contract, &p1, 2, MODE_PVP, 25 * UNIT);
    join(&env, &contract, &p2, 2);
    assert!(client.try_claim_refund(&id(&env, 2)).is_err());
    env.ledger().set_sequence_number(500);
    env.mock_auths(&[]);
    client.claim_refund(&id(&env, 2));
    assert_eq!(client.get_locked_escrow(), 0);
    assert_eq!(token::Client::new(&env, &token).balance(&p2), 50000 * UNIT);
}
#[test]
fn pause_preserves_active_inputs_settlement_and_pre_start_bot_refunds() {
    let (env, contract, token, admin, p1, p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    pvp(&env, &contract, &p1, &p2, 1, 25 * UNIT);
    client.fund_bot_pool(&admin, &(150 * UNIT));
    create(&env, &contract, &p1, 2, MODE_BOT, 25 * UNIT);
    client.set_paused(&true);
    assert!(client
        .try_create_game(
            &p1,
            &id(&env, 3),
            &MODE_PVP,
            &MIN_ENTRY,
            &500,
            &input_key(&env, 1),
            &enrollment(&env, &contract, &p1, &id(&env, 3), 1, 1)
        )
        .is_err());
    settle_p1(&env, &contract, &p1, 1);
    client.cancel_game(&p1, &id(&env, 2));
    assert_eq!(client.get_bot_liquidity(), 150 * UNIT);
    assert_eq!(client.get_locked_escrow(), 0);
    assert_eq!(
        token::Client::new(&env, &token).balance(&contract),
        155 * UNIT
    );
}
#[test]
fn bot_wins_and_player_wins_are_computed_from_the_same_unchanged_engine() {
    let (env, contract, _, admin, p1, _) = world();
    let client = ChainDuelClient::new(&env, &contract);
    client.fund_bot_pool(&admin, &(200 * UNIT));
    create(&env, &contract, &p1, 1, MODE_BOT, 25 * UNIT);
    client.start_game(&id(&env, 1));
    let win = settle_p1(&env, &contract, &p1, 1);
    assert_eq!(win.winner, Some(p1.clone()));
    assert_eq!(win.payout, 45 * UNIT);
    create(&env, &contract, &p1, 2, MODE_BOT, 25 * UNIT);
    let game = client.start_game(&id(&env, 2));
    after_end(&env, &game);
    submit(&env, &contract, &game, &p1, 1, &Bytes::new(&env), true);
    let bot = client.settle_game(&game.id);
    assert_eq!(bot.winner, Some(admin));
    assert!(bot.player_two_score > 0);
    assert_eq!(
        (client.get_stats().player_wins, client.get_stats().bot_wins),
        (1, 1)
    );
}
#[test]
fn administrator_playing_as_a_player_is_not_miscounted_as_a_computer_win() {
    let (env, contract, _, admin, _, _) = world();
    let client = ChainDuelClient::new(&env, &contract);
    client.fund_bot_pool(&admin, &(150 * UNIT));
    create(&env, &contract, &admin, 1, MODE_BOT, 25 * UNIT);
    client.start_game(&id(&env, 1));
    let result = settle_p1(&env, &contract, &admin, 1);
    assert_eq!(result.winner, Some(admin));
    assert_eq!(
        (client.get_stats().player_wins, client.get_stats().bot_wins),
        (1, 0)
    );
}
#[test]
fn bot_liquidity_and_reserve_remain_separate_from_committed_player_funds() {
    let (env, contract, _, admin, p1, _) = world();
    let client = ChainDuelClient::new(&env, &contract);
    client.fund_bot_pool(&admin, &(150 * UNIT));
    create(&env, &contract, &p1, 1, MODE_BOT, 25 * UNIT);
    client.withdraw_bot_liquidity(&(25 * UNIT), &id(&env, 50));
    assert_eq!(
        (client.get_bot_liquidity(), client.get_locked_escrow()),
        (100 * UNIT, 50 * UNIT)
    );
    assert!(client
        .try_withdraw_bot_liquidity(&1, &id(&env, 51))
        .is_err());
    assert!(client
        .try_create_game(
            &p1,
            &id(&env, 2),
            &MODE_BOT,
            &MIN_ENTRY,
            &500,
            &input_key(&env, 1),
            &enrollment(&env, &contract, &p1, &id(&env, 2), 1, 1)
        )
        .is_err());
    client.cancel_game(&p1, &id(&env, 1));
    assert_eq!(client.get_bot_liquidity(), 125 * UNIT);
}
#[test]
fn no_result_can_pay_before_the_actual_60_second_clock_finishes() {
    let (env, contract, token, _, p1, p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    let game = pvp(&env, &contract, &p1, &p2, 1, 25 * UNIT);
    assert!(client.try_settle_game(&game.id).is_err());
    assert_eq!(client.get_locked_escrow(), 50 * UNIT);
    assert_eq!(
        token::Client::new(&env, &token).balance(&contract),
        50 * UNIT
    );
    env.ledger()
        .set_timestamp((game.play_start_ms + 1000) / 1000);
    let first = submit(&env, &contract, &game, &p1, 1, &Bytes::new(&env), true);
    submit(&env, &contract, &first, &p2, 2, &Bytes::new(&env), true);
    assert!(client.try_settle_game(&game.id).is_err());
    after_end(&env, &game);
    assert_eq!(client.settle_game(&game.id).winner, Some(p1));
}
#[test]
fn withheld_inputs_settle_as_zero_after_the_deadline_without_incomplete_game_refunds() {
    let (env, contract, _, _, p1, p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    let game = pvp(&env, &contract, &p1, &p2, 1, 25 * UNIT);
    after_end(&env, &game);
    submit(&env, &contract, &game, &p1, 1, &perfect(&env, &game), false);
    assert!(client.try_settle_game(&game.id).is_err());
    assert!(client.try_claim_refund(&game.id).is_err());
    after_deadline(&env, &game);
    env.mock_auths(&[]);
    let result = client.settle_game(&game.id);
    assert_eq!(result.winner, Some(p1));
    assert_eq!(result.player_two_score, 0);
    assert_eq!(result.payout, 45 * UNIT);
}
#[test]
fn both_missing_inputs_follow_the_existing_seat_one_tie_break() {
    let (env, contract, _, _, p1, p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    let game = pvp(&env, &contract, &p1, &p2, 1, 25 * UNIT);
    after_deadline(&env, &game);
    let settled = client.settle_game(&game.id);
    assert_eq!(
        (
            settled.player_one_score,
            settled.player_two_score,
            settled.player_one_combo,
            settled.player_two_combo
        ),
        (0, 0, 0, 0)
    );
    assert_eq!(settled.winner, Some(p1));
}
#[test]
fn identical_legal_scores_and_combos_follow_the_same_existing_seat_tie_break() {
    let (env, contract, _, _, p1, p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    let mut game = pvp(&env, &contract, &p1, &p2, 1, 25 * UNIT);
    after_end(&env, &game);
    let input = perfect(&env, &game);
    game = submit(&env, &contract, &game, &p1, 1, &input, true);
    submit(&env, &contract, &game, &p2, 2, &input, true);
    let result = client.settle_game(&game.id);
    assert_eq!(
        (result.player_one_score, result.player_one_combo),
        (result.player_two_score, result.player_two_combo)
    );
    assert_eq!(result.winner, Some(p1));
}
#[test]
fn forged_player_authorizations_and_manipulated_transcripts_are_rejected_atomically() {
    let (env, contract, _, _, p1, p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    let game = pvp(&env, &contract, &p1, &p2, 1, 25 * UNIT);
    after_end(&env, &game);
    let input = perfect(&env, &game);
    let wrong = packet_signature(&env, &contract, &game, &p1, 99, 0, true, &input);
    assert!(client
        .try_submit_inputs(&game.id, &p1, &0, &true, &input, &wrong)
        .is_err());
    let valid = packet_signature(&env, &contract, &game, &p1, 1, 0, true, &input);
    let changed = events(&env, &[(1000, 0)]);
    assert!(client
        .try_submit_inputs(&game.id, &p1, &0, &true, &changed, &valid)
        .is_err());
    assert_eq!(
        (
            client.get_game(&game.id).inputs_one.state.events,
            client.get_locked_escrow()
        ),
        (0, 50 * UNIT)
    );
}
#[test]
fn a_higher_verified_maximum_combo_wins_even_when_score_and_seat_favor_the_other_player() {
    let (env, contract, _, _, p1, p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    let mut game = pvp(&env, &contract, &p1, &p2, 1, 25 * UNIT);
    after_end(&env, &game);
    let seed = hex_seed(&game.seed);
    let schedule = build_schedule(core::str::from_utf8(&seed).unwrap(), GAME_DURATION_MS).unwrap();
    let mut positive = 0;
    let mut input = Vec::new();
    for (index, target) in schedule.targets[..schedule.len].iter().enumerate() {
        if positive < 3 && target.points > 0 {
            input.push((target.spawn + 80, (index + 1) as u16));
            positive += 1;
        } else if positive == 3 && target.points < 0 {
            input.push((target.spawn + 80, (index + 1) as u16));
        }
    }
    game = submit(&env, &contract, &game, &p1, 1, &Bytes::new(&env), true);
    let second = submit(&env, &contract, &game, &p2, 2, &events(&env, &input), true);
    assert_eq!(second.inputs_two.state.score.score, 0);
    assert!(second.inputs_two.state.score.max_combo > 0);
    assert_eq!(client.settle_game(&game.id).winner, Some(p2));
}
#[test]
fn invalid_reordered_duplicate_expired_and_future_moves_are_rejected() {
    let (env, contract, _, _, p1, p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    let game = pvp(&env, &contract, &p1, &p2, 1, 25 * UNIT);
    after_end(&env, &game);
    let seed = hex_seed(&game.seed);
    let schedule = build_schedule(core::str::from_utf8(&seed).unwrap(), GAME_DURATION_MS).unwrap();
    let target = schedule.targets[0];
    for entries in [
        std::vec![(0, 65000)],
        std::vec![(target.spawn + 69, 1)],
        std::vec![(target.expires + 1, 1)],
        std::vec![(target.spawn + 70, 1), (target.spawn + 71, 1)],
        std::vec![(1000, 0), (999, 0)],
        std::vec![(60001, 0)],
    ] {
        let input = events(&env, &entries);
        let proof = packet_signature(&env, &contract, &game, &p1, 1, 0, false, &input);
        assert!(client
            .try_submit_inputs(&game.id, &p1, &0, &false, &input, &proof)
            .is_err());
        assert_eq!(client.get_game(&game.id).inputs_one.state.events, 0);
    }
    env.ledger()
        .set_timestamp((game.play_start_ms + 1000) / 1000);
    let future = events(&env, &[(5000, 0)]);
    let proof = packet_signature(&env, &contract, &game, &p1, 1, 0, false, &future);
    assert!(client
        .try_submit_inputs(&game.id, &p1, &0, &false, &future, &proof)
        .is_err());
}
#[test]
fn a_bad_final_move_rolls_back_every_earlier_move_in_the_same_batch() {
    let (env, contract, _, _, p1, p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    let game = pvp(&env, &contract, &p1, &p2, 1, 25 * UNIT);
    after_end(&env, &game);
    let seed = hex_seed(&game.seed);
    let schedule = build_schedule(core::str::from_utf8(&seed).unwrap(), GAME_DURATION_MS).unwrap();
    let first = schedule.targets[0];
    let input = events(&env, &[(first.spawn + 70, 1), (first.spawn + 71, 65000)]);
    let proof = packet_signature(&env, &contract, &game, &p1, 1, 0, false, &input);
    assert!(client
        .try_submit_inputs(&game.id, &p1, &0, &false, &input, &proof)
        .is_err());
    let actual = client.get_game(&game.id);
    assert_eq!(
        (
            actual.inputs_one.state.events,
            actual.inputs_one.state.score.score
        ),
        (0, 0)
    );
}
#[test]
fn sequences_closure_and_deadlines_prevent_duplicate_or_late_input() {
    let (env, contract, _, _, p1, p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    let game = pvp(&env, &contract, &p1, &p2, 1, 25 * UNIT);
    after_end(&env, &game);
    let input = events(&env, &[(1000, 0)]);
    let proof = packet_signature(&env, &contract, &game, &p1, 1, 1, false, &input);
    assert!(client
        .try_submit_inputs(&game.id, &p1, &1, &false, &input, &proof)
        .is_err());
    let actual = submit(&env, &contract, &game, &p1, 1, &input, false);
    let old = packet_signature(&env, &contract, &game, &p1, 1, 0, false, &input);
    assert!(client
        .try_submit_inputs(&game.id, &p1, &0, &false, &input, &old)
        .is_err());
    let closed = submit(&env, &contract, &actual, &p1, 1, &Bytes::new(&env), true);
    let again = packet_signature(&env, &contract, &closed, &p1, 1, 1, true, &Bytes::new(&env));
    assert!(client
        .try_submit_inputs(&game.id, &p1, &1, &true, &Bytes::new(&env), &again)
        .is_err());
    after_deadline(&env, &game);
    let late = packet_signature(&env, &contract, &closed, &p2, 2, 0, true, &Bytes::new(&env));
    assert!(client
        .try_submit_inputs(&game.id, &p2, &0, &true, &Bytes::new(&env), &late)
        .is_err());
}
#[test]
fn cross_game_cross_seat_and_cross_network_replays_cannot_authorize_inputs() {
    let (env, contract, _, _, p1, p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    let one = pvp(&env, &contract, &p1, &p2, 1, 25 * UNIT);
    let two = pvp(&env, &contract, &p1, &p2, 2, 25 * UNIT);
    after_end(&env, &two);
    let empty = Bytes::new(&env);
    let proof = packet_signature(&env, &contract, &one, &p1, 1, 0, true, &empty);
    assert!(client
        .try_submit_inputs(&two.id, &p1, &0, &true, &empty, &proof)
        .is_err());
    assert!(client
        .try_submit_inputs(&one.id, &p2, &0, &true, &empty, &proof)
        .is_err());
    let original = env.ledger().network_id().to_array();
    env.ledger().set_network_id([7; 32]);
    let foreign = packet_signature(&env, &contract, &one, &p1, 1, 0, true, &empty);
    env.ledger().set_network_id(original);
    assert!(client
        .try_submit_inputs(&one.id, &p1, &0, &true, &empty, &foreign)
        .is_err());
}
#[test]
fn player_controlled_key_rotation_preserves_verified_inputs_and_rejects_the_old_key() {
    let (env, contract, _, _, p1, p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    let game = pvp(&env, &contract, &p1, &p2, 1, 25 * UNIT);
    after_end(&env, &game);
    let first = submit(
        &env,
        &contract,
        &game,
        &p1,
        1,
        &events(&env, &[(1000, 0)]),
        false,
    );
    let rotated = client.rotate_input_key(
        &game.id,
        &p1,
        &input_key(&env, 9),
        &enrollment(&env, &contract, &p1, &game.id, 1, 9),
    );
    assert_eq!(
        (
            rotated.inputs_one.state.events,
            rotated.inputs_one.key_epoch
        ),
        (1, 1)
    );
    assert_eq!(rotated.inputs_one.commitment, first.inputs_one.commitment);
    let input = events(&env, &[(1001, 0)]);
    let old = packet_signature(&env, &contract, &rotated, &p1, 1, 1, true, &input);
    assert!(client
        .try_submit_inputs(&game.id, &p1, &1, &true, &input, &old)
        .is_err());
    submit(&env, &contract, &rotated, &p1, 9, &input, true);
}
#[test]
fn an_administrator_cannot_rotate_another_players_game_key() {
    let (env, contract, _, _, p1, p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    let game = pvp(&env, &contract, &p1, &p2, 1, 25 * UNIT);
    let proof = enrollment(&env, &contract, &p1, &game.id, 1, 9);
    env.mock_auths(&[]);
    assert!(client
        .try_rotate_input_key(&game.id, &p1, &input_key(&env, 9), &proof)
        .is_err());
    assert_eq!(
        client.get_game(&game.id).inputs_one.public_key,
        input_key(&env, 1)
    );
}
#[test]
fn the_original_fabricated_result_attack_no_longer_overrides_a_verified_game() {
    let (env, contract, token, admin, p1, _) = world();
    let client = ChainDuelClient::new(&env, &contract);
    client.fund_bot_pool(&admin, &(150 * UNIT));
    create(&env, &contract, &p1, 1, MODE_BOT, 25 * UNIT);
    let mut game = client.start_game(&id(&env, 1));
    // Original 50-unit attack: admin supplied scores 0/1 and declared a bot win.
    // That ABI is no longer a payout capability, even with all native auth mocked.
    let old_args = soroban_sdk::vec![
        &env,
        game.id.clone().into_val(&env),
        admin.clone().into_val(&env),
        0_i64.into_val(&env),
        1_i64.into_val(&env),
        0_i64.into_val(&env),
        0_i64.into_val(&env),
        id(&env, 99).into_val(&env)
    ];
    assert!(env
        .try_invoke_contract::<Game, Error>(
            &contract,
            &soroban_sdk::Symbol::new(&env, "settle_game"),
            old_args
        )
        .is_err());
    assert!(client.try_settle_game(&game.id).is_err());
    after_end(&env, &game);
    game = submit(&env, &contract, &game, &p1, 1, &perfect(&env, &game), false);
    let forged = packet_signature(
        &env,
        &contract,
        &game,
        &p1,
        99,
        game.inputs_one.state.events,
        true,
        &Bytes::new(&env),
    );
    assert!(client
        .try_submit_inputs(
            &game.id,
            &p1,
            &game.inputs_one.state.events,
            &true,
            &Bytes::new(&env),
            &forged
        )
        .is_err());
    game = submit(&env, &contract, &game, &p1, 1, &Bytes::new(&env), true);
    let balance_before = token::Client::new(&env, &token).balance(&p1);
    let settled = client.settle_game(&game.id);
    assert_eq!(settled.winner, Some(p1.clone()));
    assert_eq!(
        token::Client::new(&env, &token).balance(&p1),
        balance_before + 45 * UNIT
    );
    assert_eq!(settled.payout, 45 * UNIT);
}
#[test]
fn the_backend_cannot_supply_or_manipulate_the_computer_transcript() {
    let (env, contract, _, admin, p1, _) = world();
    let client = ChainDuelClient::new(&env, &contract);
    client.fund_bot_pool(&admin, &(150 * UNIT));
    create(&env, &contract, &p1, 1, MODE_BOT, 25 * UNIT);
    let game = client.start_game(&id(&env, 1));
    after_end(&env, &game);
    assert!(client
        .try_submit_inputs(
            &game.id,
            &admin,
            &0,
            &true,
            &Bytes::new(&env),
            &BytesN::from_array(&env, &[0; 64])
        )
        .is_err());
    assert!(client
        .try_join_game(
            &admin,
            &game.id,
            &input_key(&env, 2),
            &enrollment(&env, &contract, &admin, &game.id, 2, 2)
        )
        .is_err());
}
#[test]
fn failed_token_payout_rolls_back_settlement_and_both_fee_buckets() {
    let (env, contract, token, _, p1, p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    let mut game = pvp(&env, &contract, &p1, &p2, 1, 25 * UNIT);
    after_end(&env, &game);
    game = submit(&env, &contract, &game, &p1, 1, &perfect(&env, &game), true);
    submit(&env, &contract, &game, &p2, 2, &Bytes::new(&env), true);
    token::StellarAssetClient::new(&env, &token).set_authorized(&p1, &false);
    assert!(client.try_settle_game(&game.id).is_err());
    assert_eq!(
        (
            client.get_locked_escrow(),
            client.get_protocol_fees(),
            client.get_ecosystem_fees()
        ),
        (50 * UNIT, 0, 0)
    );
    assert_eq!(client.get_game(&game.id).status, STATUS_ACTIVE);
    token::StellarAssetClient::new(&env, &token).set_authorized(&p1, &true);
    assert_eq!(client.settle_game(&game.id).payout, 45 * UNIT);
}
#[test]
fn varied_256_games_conserve_supply_and_every_withdrawable_bucket() {
    let (env, contract, _, _, p1, p2) = world();
    let client = ChainDuelClient::new(&env, &contract);
    let mut protocol = 0;
    let mut ecosystem = 0;
    let mut volume = 0;
    for n in 0..256_u32 {
        let game_id = BytesN::from_array(&env, &[n as u8; 32]);
        let entry = (25 + i128::from(n % 13)) * UNIT + i128::from(n % 17);
        let proof = enrollment(&env, &contract, &p1, &game_id, 1, 1);
        client.create_game(
            &p1,
            &game_id,
            &MODE_PVP,
            &entry,
            &500,
            &input_key(&env, 1),
            &proof,
        );
        client.join_game(
            &p2,
            &game_id,
            &input_key(&env, 2),
            &enrollment(&env, &contract, &p2, &game_id, 2, 2),
        );
        client.start_game(&game_id);
        let result = settle_p1(&env, &contract, &p1, n as u8);
        protocol += result.protocol_fee;
        ecosystem += result.ecosystem_fee;
        volume += 2 * entry;
        assert_eq!(
            result.payout + result.protocol_fee + result.ecosystem_fee,
            2 * entry
        );
        assert_eq!(client.get_locked_escrow(), 0);
        assert_eq!(client.get_contract_balance(), protocol + ecosystem);
    }
    assert_eq!(
        (client.get_stats().games_settled, client.get_stats().volume),
        (256, volume)
    );
}
