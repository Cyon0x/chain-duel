//! Participant-authorized inputs and independent replay. No backend score oracle.
use pulse_replay::{Session, SessionCheckpoint};
use soroban_sdk::{contracttype, xdr::ToXdr, Address, Bytes, BytesN, Env};

pub const RULES_VERSION: u32 = 1;
pub const START_CONFIRMATION_BUFFER_MS: u64 = 10_000;

#[contracttype]
#[derive(Clone, Debug)]
pub struct PlayerInputs {
    pub public_key: BytesN<32>,
    pub key_epoch: u32,
    pub state: SessionCheckpoint,
    pub commitment: BytesN<32>,
    pub closed: bool,
}

impl PlayerInputs {
    pub fn new(env: &Env, public_key: BytesN<32>) -> Self {
        Self {
            public_key,
            key_epoch: 0,
            state: Session::default().checkpoint(env),
            commitment: BytesN::from_array(env, &[0; 32]),
            closed: false,
        }
    }
}

pub fn hex_seed(seed: &BytesN<32>) -> [u8; 64] {
    let mut text = [0_u8; 64];
    let digits = b"0123456789abcdef";
    for (index, byte) in seed.to_array().iter().enumerate() {
        text[index * 2] = digits[(byte >> 4) as usize];
        text[index * 2 + 1] = digits[(byte & 15) as usize];
    }
    text
}

pub fn rules_hash(env: &Env) -> BytesN<32> {
    // This version is checked against unchanged pre-upgrade TypeScript vectors.
    // The full implementation/parity evidence, not this label alone, establishes
    // independent verification. This is a signature-domain/rules identifier.
    env.crypto().sha256(&Bytes::from_slice(env,b"ChainDuel:Pulse:v1|FNV1a_UTF16|Mulberry32|60000|3200|pace=1.25|blue=10,62,1200|gold=25,18,920|red=-15,20,1360|spawn=496,.78,1.24|max_visible=4|pressure=1.9|min_reaction=70|combo=1760,3:1.2,5:1.5,8:2|VEX7=200,.915,.935,.015,.7,40|winner=score,combo,seat1")).into()
}

pub fn enrollment_message(
    env: &Env,
    id: &BytesN<32>,
    player: &Address,
    seat: u32,
    key: &BytesN<32>,
) -> Bytes {
    let mut message = Bytes::from_slice(env, b"ChainDuel:Pulse:Enroll:v1\0");
    message.append(&env.ledger().network_id().into());
    message.append(&env.current_contract_address().to_xdr(env));
    message.append(&id.clone().into());
    message.append(&player.to_xdr(env));
    message.append(&Bytes::from_array(env, &seat.to_be_bytes()));
    message.append(&key.clone().into());
    message.append(&rules_hash(env).into());
    message
}

#[allow(clippy::too_many_arguments)]
pub fn input_message(
    env: &Env,
    id: &BytesN<32>,
    seed: &BytesN<32>,
    player: &Address,
    seat: u32,
    inputs: &PlayerInputs,
    sequence: u32,
    closed: bool,
    started_at_ms: u64,
    deadline_ms: u64,
    payload: &Bytes,
) -> Bytes {
    let mut message = Bytes::from_slice(env, b"ChainDuel:Pulse:Input:v1\0");
    message.append(&env.ledger().network_id().into());
    message.append(&env.current_contract_address().to_xdr(env));
    message.append(&id.clone().into());
    message.append(&seed.clone().into());
    message.append(&player.to_xdr(env));
    message.append(&Bytes::from_array(env, &seat.to_be_bytes()));
    message.append(&Bytes::from_array(env, &inputs.key_epoch.to_be_bytes()));
    message.append(&Bytes::from_array(env, &sequence.to_be_bytes()));
    message.append(&inputs.commitment.clone().into());
    message.append(&Bytes::from_array(env, &started_at_ms.to_be_bytes()));
    message.append(&Bytes::from_array(env, &deadline_ms.to_be_bytes()));
    message.push_back(u8::from(closed));
    message.append(&env.crypto().sha256(payload).into());
    message.append(&rules_hash(env).into());
    message
}
