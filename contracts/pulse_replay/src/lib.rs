#![no_std]
//! Financially relevant replay of the existing TypeScript Pulse engine.
//! All floating-point arithmetic is integer software IEEE-754; native WASM
//! floating-point operations are not used. The optional probe is read-only.

use softfloat::{f64, F64};
use soroban_sdk::{contracterror, contracttype};

pub const GAME_DURATION_MS: u32 = 60_000;
pub const COUNTDOWN_MS: u32 = 3_200;
pub const ABANDONMENT_WINDOW_MS: u32 = 20_000;
pub const MIN_REACTION_MS: u32 = 70;
pub const MAX_EVENTS: usize = 4_000;
pub const MAX_HITS: u32 = 1_500;
pub const EVENT_BYTES: usize = 6;
pub const MAX_TRANSCRIPT_BYTES: usize = MAX_EVENTS * EVENT_BYTES;
// The read-only probe also meters longer simulations. Escrow always uses the
// unchanged 60-second duration, whose target count is comfortably below this.
pub const MAX_TARGETS: usize = 1_024;
pub const PROBE_MAX_DURATION_MS: u32 = 300_000;
pub const COMBO_WINDOW_MS: u32 = 1_760;

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ReplayError {
    InvalidTranscript = 100,
    TooManyEvents = 101,
    InvalidTimestamp = 102,
    OutOfOrder = 103,
    UnknownTarget = 104,
    DuplicateTarget = 105,
    TooFast = 106,
    ExpiredTarget = 107,
    UnsupportedDuration = 108,
    TooManyTargets = 109,
    InvalidSeed = 110,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PulseScore {
    pub score: i64,
    pub hits: u32,
    pub misses: u32,
    pub wrong_targets: u32,
    pub max_combo: u32,
    pub best_multiplier_tenths: u32,
    pub last_hit_at_ms_bits: u64,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Target {
    pub kind: u8,
    pub spawn: u32,
    pub expires: u32,
    pub points: i32,
}
const EMPTY_TARGET: Target = Target {
    kind: 0,
    spawn: 0,
    expires: 0,
    points: 0,
};

pub struct Schedule {
    pub targets: [Target; MAX_TARGETS],
    pub len: usize,
}

fn feed_hash(mut h: u32, text: &str) -> u32 {
    // JavaScript hashSeed iterates UTF-16 code units, not UTF-8 bytes.
    for unit in text.encode_utf16() {
        h = (h ^ u32::from(unit)).wrapping_mul(16_777_619);
    }
    h
}

pub struct Rng {
    state: u32,
}
impl Rng {
    pub fn new(prefix: &str, seed: &str) -> Self {
        Self {
            state: feed_hash(feed_hash(2_166_136_261, prefix), seed),
        }
    }
    pub fn next_u32(&mut self) -> u32 {
        self.state = self.state.wrapping_add(0x6d2b79f5);
        let mut t = (self.state ^ (self.state >> 15)).wrapping_mul(self.state | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        t ^ (t >> 14)
    }
    pub fn float(&mut self) -> F64 {
        let value = self.next_u32();
        if value == 0 {
            return F64::from_bits(0);
        }
        let top = 31 - value.leading_zeros();
        let exponent = u64::from(1023 + top - 32);
        let fraction = (u64::from(value) << (52 - top)) & ((1_u64 << 52) - 1);
        F64::from_bits((exponent << 52) | fraction)
    }
    pub fn range(&mut self, min: F64, max: F64) -> F64 {
        min + self.float() * (max - min)
    }
}

pub fn number(value: u32) -> F64 {
    if value == 0 {
        return F64::from_bits(0);
    }
    let top = 31 - value.leading_zeros();
    F64::from_bits(
        (u64::from(1023 + top) << 52) | ((u64::from(value) << (52 - top)) & ((1_u64 << 52) - 1)),
    )
}

fn js_round_positive(value: F64) -> u32 {
    let floor = value.floor();
    let integral = floor.to_i32() as u32;
    integral + u32::from(value - floor >= f64!(0.5))
}

pub fn build_schedule(seed: &str, duration: u32) -> Result<Schedule, ReplayError> {
    if duration > PROBE_MAX_DURATION_MS || duration < 200 {
        return Err(ReplayError::UnsupportedDuration);
    }
    let mut rng = Rng::new("schedule:", seed);
    let mut schedule = Schedule {
        targets: [EMPTY_TARGET; MAX_TARGETS],
        len: 0,
    };
    let mut active_expiries = [0_u32; MAX_TARGETS];
    let mut active_count = 0;
    let mut at = f64!(320.0);
    while at < number(duration - 200) {
        if schedule.len == MAX_TARGETS {
            return Err(ReplayError::TooManyTargets);
        }
        let mut roll = rng.float() * f64!(100.0);
        roll -= f64!(62.0);
        let kind = if roll <= f64!(0.0) {
            0
        } else {
            roll -= f64!(18.0);
            if roll <= f64!(0.0) {
                1
            } else {
                2
            }
        };
        // Radius/x/y influence rendering, not hit legality. Consume all three
        // RNG draws exactly as the existing renderer does before spawn timing.
        rng.next_u32();
        rng.next_u32();
        rng.next_u32();
        let (points, lifetime) = match kind {
            0 => (10, 1200),
            1 => (25, 920),
            _ => (-15, 1360),
        };
        schedule.targets[schedule.len] = Target {
            kind,
            points,
            spawn: js_round_positive(at),
            expires: js_round_positive(at + number(lifetime)),
        };
        schedule.len += 1;
        // at only increases: an expired target can never become active again.
        // Retain exactly the original filter's live expiries instead of scanning
        // every historical target on each spawn (same rules, linear work).
        let mut retained = 0;
        for index in 0..active_count {
            if number(active_expiries[index]) > at {
                active_expiries[retained] = active_expiries[index];
                retained += 1;
            }
        }
        active_expiries[retained] = schedule.targets[schedule.len - 1].expires;
        active_count = retained + 1;
        let density = active_count;
        let pressure = if density >= 4 { f64!(1.9) } else { f64!(1.0) };
        at += f64!(496.0) * pressure * rng.range(f64!(0.78), f64!(1.24));
    }
    Ok(schedule)
}

#[derive(Clone)]
pub struct Session {
    pub score: PulseScore,
    pub combo: u32,
    pub last_positive: F64,
    pub seen: [u64; MAX_TARGETS / 64],
    pub events: u32,
    pub previous_at: Option<u32>,
    pub previous_was_miss: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionCheckpoint {
    pub score: PulseScore,
    pub combo: u32,
    pub last_positive_bits: u64,
    pub seen: soroban_sdk::BytesN<128>,
    pub events: u32,
    pub previous_at: i64,
    pub previous_was_miss: bool,
}
impl Default for Session {
    fn default() -> Self {
        Self {
            score: PulseScore {
                score: 0,
                hits: 0,
                misses: 0,
                wrong_targets: 0,
                max_combo: 0,
                best_multiplier_tenths: 10,
                last_hit_at_ms_bits: f64!(-1.0).to_bits(),
            },
            combo: 0,
            last_positive: F64::from_bits(0xfff0000000000000),
            seen: [0; MAX_TARGETS / 64],
            events: 0,
            previous_at: None,
            previous_was_miss: false,
        }
    }
}

impl Session {
    pub fn checkpoint(&self, env: &soroban_sdk::Env) -> SessionCheckpoint {
        let mut seen = [0_u8; 128];
        for (index, value) in self.seen.iter().enumerate() {
            seen[index * 8..index * 8 + 8].copy_from_slice(&value.to_be_bytes());
        }
        SessionCheckpoint {
            score: self.score.clone(),
            combo: self.combo,
            last_positive_bits: self.last_positive.to_bits(),
            seen: soroban_sdk::BytesN::from_array(env, &seen),
            events: self.events,
            previous_at: self.previous_at.map(i64::from).unwrap_or(-1),
            previous_was_miss: self.previous_was_miss,
        }
    }
    pub fn from_checkpoint(checkpoint: &SessionCheckpoint) -> Self {
        let bytes = checkpoint.seen.to_array();
        let mut seen = [0_u64; MAX_TARGETS / 64];
        for (index, value) in seen.iter_mut().enumerate() {
            let start = index * 8;
            *value = u64::from_be_bytes(bytes[start..start + 8].try_into().unwrap());
        }
        Self {
            score: checkpoint.score.clone(),
            combo: checkpoint.combo,
            last_positive: F64::from_bits(checkpoint.last_positive_bits),
            seen,
            events: checkpoint.events,
            previous_at: if checkpoint.previous_at < 0 {
                None
            } else {
                Some(checkpoint.previous_at as u32)
            },
            previous_was_miss: checkpoint.previous_was_miss,
        }
    }
    fn hit(
        &mut self,
        schedule: &Schedule,
        duration: u32,
        target_id: u32,
        at: F64,
    ) -> Result<(), ReplayError> {
        if target_id == 0 || target_id as usize > schedule.len {
            return Err(ReplayError::UnknownTarget);
        }
        let index = target_id as usize - 1;
        let target = schedule.targets[index];
        let bit = 1_u64 << (index % 64);
        if self.seen[index / 64] & bit != 0 {
            return Err(ReplayError::DuplicateTarget);
        }
        if at < number(target.spawn + MIN_REACTION_MS) {
            return Err(ReplayError::TooFast);
        }
        if at > number(target.expires) {
            return Err(ReplayError::ExpiredTarget);
        }
        if at > number(duration) {
            return Err(ReplayError::InvalidTimestamp);
        }
        self.seen[index / 64] |= bit;
        self.score.last_hit_at_ms_bits = at.to_bits();
        if target.points > 0 {
            self.combo = if at - self.last_positive > number(COMBO_WINDOW_MS) {
                1
            } else {
                self.combo + 1
            };
            self.last_positive = at;
            let multiplier = if self.combo >= 8 {
                20
            } else if self.combo >= 5 {
                15
            } else if self.combo >= 3 {
                12
            } else {
                10
            };
            let points = (target.points as i64 * i64::from(multiplier) + 5) / 10;
            self.score.score += points;
            self.score.hits += 1;
            self.score.max_combo = core::cmp::max(self.score.max_combo, self.combo);
            self.score.best_multiplier_tenths =
                core::cmp::max(self.score.best_multiplier_tenths, multiplier);
        } else {
            self.combo = 0;
            self.score.wrong_targets += 1;
            self.score.score = core::cmp::max(0, self.score.score + i64::from(target.points));
        }
        Ok(())
    }
    fn miss(&mut self, duration: u32, at: F64) -> Result<(), ReplayError> {
        if at > number(duration) {
            return Err(ReplayError::InvalidTimestamp);
        }
        self.combo = 0;
        self.score.misses += 1;
        Ok(())
    }
    pub fn apply_transcript(
        &mut self,
        schedule: &Schedule,
        duration: u32,
        input: &[u8],
    ) -> Result<(), ReplayError> {
        if input.len() % EVENT_BYTES != 0 {
            return Err(ReplayError::InvalidTranscript);
        }
        if input.len() / EVENT_BYTES + self.events as usize > MAX_EVENTS {
            return Err(ReplayError::TooManyEvents);
        }
        for event in input.chunks_exact(EVENT_BYTES) {
            let at = u32::from_be_bytes([event[0], event[1], event[2], event[3]]);
            let id = u16::from_be_bytes([event[4], event[5]]) as u32;
            if at > duration {
                return Err(ReplayError::InvalidTimestamp);
            }
            if let Some(previous) = self.previous_at {
                if at < previous || (at == previous && self.previous_was_miss && id != 0) {
                    return Err(ReplayError::OutOfOrder);
                }
            }
            if id == 0 {
                self.miss(duration, number(at))?;
            } else {
                self.hit(schedule, duration, id, number(at))?;
            }
            if self.score.hits + self.score.wrong_targets > MAX_HITS {
                return Err(ReplayError::TooManyEvents);
            }
            self.events += 1;
            self.previous_at = Some(at);
            self.previous_was_miss = id == 0;
        }
        Ok(())
    }
}

pub fn replay(seed: &str, duration: u32, input: &[u8]) -> Result<PulseScore, ReplayError> {
    let schedule = build_schedule(seed, duration)?;
    let mut session = Session::default();
    session.apply_transcript(&schedule, duration, input)?;
    Ok(session.score)
}

pub fn bot_score(
    seed: &str,
    duration: u32,
    schedule: &Schedule,
) -> Result<PulseScore, ReplayError> {
    let mut rng = Rng::new("bot:cd-computer-01:", seed);
    let mut session = Session::default();
    for (index, target) in schedule.targets[..schedule.len].iter().enumerate() {
        let attempt = rng.float();
        let mistake = rng.float();
        let miss = rng.float();
        let offset =
            (f64!(200.0) + rng.range(f64!(-40.0), f64!(40.0))).max(number(MIN_REACTION_MS));
        let at = number(target.spawn) + offset;
        let skill = if target.points > 0 && target.kind == 1 {
            f64!(0.935)
        } else {
            f64!(0.915)
        };
        let chance = (skill + f64!(0.7) * (f64!(1.0) - skill) * f64!(0.2))
            .min(f64!(0.995))
            .max(f64!(0.0));
        if at > number(duration) {
            break;
        }
        if target.points < 0 {
            if mistake < f64!(0.015) {
                session.hit(
                    schedule,
                    duration,
                    (index + 1) as u32,
                    at.min(number(target.expires)),
                )?;
            }
        } else if at <= number(target.expires) && at >= number(target.spawn) {
            if attempt < chance {
                session.hit(schedule, duration, (index + 1) as u32, at)?;
            } else if miss < f64!(0.25) {
                session.miss(duration, at.min(number(duration)))?;
            }
        }
    }
    Ok(session.score)
}

/// Stable financial schedule bytes for cross-language parity evidence.
pub fn schedule_bytes(schedule: &Schedule, output: &mut [u8; MAX_TARGETS * 13]) -> usize {
    for (index, target) in schedule.targets[..schedule.len].iter().enumerate() {
        let start = index * 13;
        output[start..start + 2].copy_from_slice(&((index + 1) as u16).to_be_bytes());
        output[start + 2..start + 6].copy_from_slice(&target.spawn.to_be_bytes());
        output[start + 6..start + 10].copy_from_slice(&target.expires.to_be_bytes());
        output[start + 10] = target.kind;
        output[start + 11..start + 13].copy_from_slice(&(target.points as i16).to_be_bytes());
    }
    schedule.len * 13
}

#[cfg(feature = "probe")]
mod probe {
    use super::*;
    use soroban_sdk::{contract, contractimpl, Bytes, BytesN, Env, String};
    #[contract]
    pub struct PulseReplay;
    #[contractimpl]
    impl PulseReplay {
        pub fn preview(
            env: Env,
            seed: String,
            duration: u32,
            transcript: Bytes,
        ) -> Result<(PulseScore, PulseScore, BytesN<32>), ReplayError> {
            if seed.len() > 128 {
                return Err(ReplayError::InvalidSeed);
            }
            if transcript.len() as usize > MAX_TRANSCRIPT_BYTES {
                return Err(ReplayError::TooManyEvents);
            }
            let mut seed_buffer = [0_u8; 128];
            seed.copy_into_slice(&mut seed_buffer[..seed.len() as usize]);
            let seed = core::str::from_utf8(&seed_buffer[..seed.len() as usize])
                .map_err(|_| ReplayError::InvalidSeed)?;
            let mut input = [0_u8; MAX_TRANSCRIPT_BYTES];
            transcript.copy_into_slice(&mut input[..transcript.len() as usize]);
            let schedule = build_schedule(seed, duration)?;
            let mut session = Session::default();
            session.apply_transcript(&schedule, duration, &input[..transcript.len() as usize])?;
            let bot = bot_score(seed, duration, &schedule)?;
            let mut packed = [0_u8; MAX_TARGETS * 13];
            let size = schedule_bytes(&schedule, &mut packed);
            let hash = env
                .crypto()
                .sha256(&Bytes::from_slice(&env, &packed[..size]));
            Ok((session.score, bot, hash.into()))
        }
    }
}

#[cfg(test)]
extern crate std;
#[cfg(test)]
mod test;
