use super::*;
use sha2::{Digest, Sha256};
use std::{format, vec::Vec};

fn decode(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).unwrap())
        .collect()
}
fn events(values: &[(u32, u16)]) -> Vec<u8> {
    let mut input = Vec::new();
    for (at, id) in values {
        input.extend_from_slice(&at.to_be_bytes());
        input.extend_from_slice(&id.to_be_bytes());
    }
    input
}
fn check_score(actual: &PulseScore, expected: &serde_json::Value) {
    assert_eq!(actual.score, expected["score"].as_i64().unwrap());
    assert_eq!(
        actual.hits,
        u32::try_from(expected["hits"].as_u64().unwrap()).unwrap()
    );
    assert_eq!(
        actual.misses,
        u32::try_from(expected["misses"].as_u64().unwrap()).unwrap()
    );
    assert_eq!(
        actual.wrong_targets,
        u32::try_from(expected["wrong_targets"].as_u64().unwrap()).unwrap()
    );
    assert_eq!(
        actual.max_combo,
        u32::try_from(expected["max_combo"].as_u64().unwrap()).unwrap()
    );
    assert_eq!(
        actual.best_multiplier_tenths,
        u32::try_from(expected["best_multiplier_tenths"].as_u64().unwrap()).unwrap()
    );
    assert_eq!(
        format!("{:016x}", actual.last_hit_at_ms_bits),
        expected["last_hit_at_ms_bits"].as_str().unwrap()
    );
}

#[test]
fn exact_original_schedule_human_and_vex7_parity_for_192_complete_games() {
    let data: serde_json::Value =
        serde_json::from_str(include_str!("../test-vectors.json")).unwrap();
    assert_eq!(
        data["baselineCommit"],
        "89eb64284399d1fdfbe03eafa00614dc4e5bec50"
    );
    let vectors = data["vectors"].as_array().unwrap();
    assert_eq!(vectors.len(), 192);
    for vector in vectors {
        let seed = vector["seed"].as_str().unwrap();
        let duration = vector["durationMs"].as_u64().unwrap() as u32;
        let schedule = build_schedule(seed, duration).unwrap();
        assert_eq!(
            schedule.len,
            vector["targetCount"].as_u64().unwrap() as usize,
            "target count for {seed}"
        );
        let mut packed = [0_u8; MAX_TARGETS * 13];
        let size = schedule_bytes(&schedule, &mut packed);
        let digest = Sha256::digest(&packed[..size]);
        assert_eq!(
            format!("{digest:x}"),
            vector["scheduleSha256"].as_str().unwrap(),
            "schedule parity for {seed}"
        );
        let mut session = Session::default();
        session
            .apply_transcript(
                &schedule,
                duration,
                &decode(vector["inputHex"].as_str().unwrap()),
            )
            .unwrap();
        check_score(&session.score, &vector["human"]);
        check_score(
            &bot_score(seed, duration, &schedule).unwrap(),
            &vector["bot"],
        );
    }
}

#[test]
fn malformed_unknown_duplicate_premature_expired_and_reordered_moves_are_rejected() {
    let schedule = build_schedule("attack-fixture", GAME_DURATION_MS).unwrap();
    let target = schedule.targets[0];
    assert_eq!(
        replay("attack-fixture", GAME_DURATION_MS, &[1]),
        Err(ReplayError::InvalidTranscript)
    );
    assert_eq!(
        replay("attack-fixture", GAME_DURATION_MS, &events(&[(0, 60000)])),
        Err(ReplayError::UnknownTarget)
    );
    assert_eq!(
        replay(
            "attack-fixture",
            GAME_DURATION_MS,
            &events(&[(target.spawn + 69, 1)])
        ),
        Err(ReplayError::TooFast)
    );
    assert_eq!(
        replay(
            "attack-fixture",
            GAME_DURATION_MS,
            &events(&[(target.expires + 1, 1)])
        ),
        Err(ReplayError::ExpiredTarget)
    );
    assert_eq!(
        replay(
            "attack-fixture",
            GAME_DURATION_MS,
            &events(&[(target.spawn + 70, 1), (target.spawn + 71, 1)])
        ),
        Err(ReplayError::DuplicateTarget)
    );
    assert_eq!(
        replay(
            "attack-fixture",
            GAME_DURATION_MS,
            &events(&[(1000, 0), (999, 0)])
        ),
        Err(ReplayError::OutOfOrder)
    );
    assert_eq!(
        replay("attack-fixture", GAME_DURATION_MS, &events(&[(60001, 0)])),
        Err(ReplayError::InvalidTimestamp)
    );
}

#[test]
fn full_existing_event_limit_is_supported_and_cannot_be_bypassed_by_chunking() {
    let schedule = build_schedule("event-boundary", GAME_DURATION_MS).unwrap();
    let input = events(&[(0, 0); MAX_EVENTS]);
    let mut session = Session::default();
    session
        .apply_transcript(&schedule, GAME_DURATION_MS, &input)
        .unwrap();
    assert_eq!(session.score.score, 0);
    assert_eq!(session.score.misses, MAX_EVENTS as u32);
    assert_eq!(
        session.apply_transcript(&schedule, GAME_DURATION_MS, &events(&[(1, 0)])),
        Err(ReplayError::TooManyEvents)
    );
}

#[test]
fn valid_chunked_input_replays_to_the_same_score_and_preserves_duplicate_history() {
    let schedule = build_schedule("chunk-parity", GAME_DURATION_MS).unwrap();
    let actions: Vec<(u32, u16)> = schedule.targets[..schedule.len]
        .iter()
        .enumerate()
        .filter(|(_, target)| target.points > 0)
        .map(|(index, target)| (target.spawn + 80, (index + 1) as u16))
        .collect();
    let input = events(&actions);
    let expected = replay("chunk-parity", GAME_DURATION_MS, &input).unwrap();
    let mut session = Session::default();
    for chunk in input.chunks(18) {
        session
            .apply_transcript(&schedule, GAME_DURATION_MS, chunk)
            .unwrap();
    }
    assert_eq!(session.score, expected);
    let (at, id) = actions[actions.len() - 1];
    assert_eq!(
        session.apply_transcript(&schedule, GAME_DURATION_MS, &events(&[(at, id)])),
        Err(ReplayError::DuplicateTarget)
    );
}

#[test]
fn rounding_and_rng_use_exact_ieee754_and_javascript_unsigned_semantics() {
    assert_eq!(
        js_round_positive(F64::from_bits(f64!(1000.5).to_bits() - 1)),
        1000
    );
    assert_eq!(js_round_positive(f64!(1000.5)), 1001);
    for value in [0, 1, 0x7fffffff, 0x80000000, 0xffffffff] {
        assert_eq!(number(value).to_native_f64(), f64::from(value));
    }
    let mut rng = Rng::new("schedule:", "overflow-fixture");
    for _ in 0..10000 {
        let value = rng.float().to_native_f64();
        assert!(value >= 0.0 && value < 1.0);
    }
}

#[cfg(feature = "probe")]
#[test]
#[ignore = "Build the pinned CLI probe WASM first; native tests do not meter WASM execution"]
fn compiled_wasm_resource_probe() {
    use soroban_sdk::{Bytes, Env, String};
    let env = Env::default();
    let wasm = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/target/wasm32v1-none/release/pulse_replay.wasm"
    ))
    .expect("Build probe WASM first");
    let id = env.register(wasm.as_slice(), ());
    let client = crate::probe::PulseReplayClient::new(&env, &id);
    for (duration, count) in [(60000, 0), (60000, MAX_EVENTS), (300000, MAX_EVENTS)] {
        let input = events(&[(0, 0); MAX_EVENTS]);
        let result = client.preview(
            &String::from_str(&env, "compiled-resource-fixture"),
            &duration,
            &Bytes::from_slice(&env, &input[..count * EVENT_BYTES]),
        );
        assert_eq!(result.0.score, 0);
        let budget = env.cost_estimate().budget();
        let resources = env.cost_estimate().resources();
        let fee = env.cost_estimate().fee();
        std::println!("PULSE_REPLAY_COST duration_ms={} events={} cpu={} memory={} fee_estimate_units={} resources={:?}",duration,count,budget.cpu_instruction_cost(),budget.memory_bytes_cost(),fee.total,resources);
    }
}
