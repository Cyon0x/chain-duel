# Player-controlled Stellar signing — proposed implementation and migration

This design is documented before implementing the custody change. The owner
approved player-controlled signing and the existing zero-score timeout outcome.
Development and controlled Testnet validation are authorized. Mainnet deployment
and irreversible wallet/key migrations require a later explicit approval after
reviewing architecture, tests, security implications and the migration plan.

## Addresses and administrative separation

The existing deployment/admin/fee wallet remains the checksum-valid address
`GCQKVXWIQHVGUOUHZR2O6YBWBNNPKIYH5AWQHXHF3EYRHM73WIWVSK7K`.
Recent text ending `VSK7` omits its final checksum character; it cannot be used
as an address. No account, keypair or additional signer will replace or modify
the designated deployment wallet.

Player custody changes affect player signing authority, not contract ownership.
Stellar classic accounts keep their `G...` account IDs when authorized signers
change. Adding player-controlled signer keys therefore preserves existing player
addresses, balances, wallet associations, profiles, game histories and deposits.
Signer public keys are credentials, not newly funded deployment/treasury accounts.

## New social-login wallets

Google/X OAuth, account IDs and profiles remain unchanged. After an authenticated
social-login callback, the browser creates the player's Ed25519 signing material
using Web Crypto. The backend receives the public address and an encrypted
recovery envelope, never a plaintext key, seed or recovery secret.

The browser stores a nonextractable signing `CryptoKey` in IndexedDB. A transient
exportable representation may be used only within the browser to encrypt the
recovery backup, then discarded and replaced with a nonextractable key. No raw
private key is sent to an API or embedded in frontend bundles/logs.

A newly generated player address uses its own client-held primary key; the same
key can be recovered from the client-encrypted backup. Automatic wallet creation
remains part of social onboarding. Device recovery must occur before a returning
user creates a replacement wallet: an unavailable local key is not permission
to silently change the player's address.

## Existing server-custodied addresses

Existing keys cannot become unknown to the backend just by moving their current
ciphertext or deleting one decrypt function. Any historical copy remains a valid
account key until its authority is revoked on Stellar.

For an existing managed `G...` account, the proposed migration is:

1. The player's browser creates independent device and recovery signer keys.
2. It creates and verifies an encrypted recovery backup under a player-held,
   high-entropy recovery secret. Confirm backup recovery locally before revoking
   the old key. No recovery secret belongs in server storage.
3. A reviewed atomic classic transaction adds the device and recovery signers,
   establishes the required account thresholds, and sets the old master weight
   to zero. Either approved player-held signer can recover control; the backend's
   old master key has zero authorization weight. The original account ID remains.
4. Independently inspect Horizon/account signer state and reject the old key in
   real authorization tests before enabling verified stakes for that account.
5. Disable the old wallet-key decrypt/sign/export paths and remove their decryption
   capability from the application environment. Quarantine/delete legacy sealed
   material only through the separately approved migration, preserving records
   until the new signers and recovery have been verified.

The legacy signature needed to revoke an old master belongs in a tightly scoped,
one-time migration worker, separate from the game backend. It may sign only the
exact reviewed account-authority transition after proof that the player controls
both new keys. It must not return seeds or offer arbitrary transaction/input
signing. The live application must not retain the old decryption credential after
cutover. Until revocation is verified, historical backend custody remains a real
limitation; application flags alone do not cryptographically revoke a key.

There is also an enrollment trust boundary: possession proofs for two new keys
do not by themselves prove that the real player chose them. A backend that knows
the old account key can generate two attacker-controlled keys and fake its own
OAuth/session approval. Legacy migration therefore requires independently
confirmed, player-chosen public keys and an explicitly approved per-wallet
migration manifest outside the game backend's control. A normal backend-created
session is not sufficient authorization for this irreversible transition.
No automatic migration based only on an OAuth session will be implemented.

Adding two signer entries typically adds 1 XLM of reserve at a 0.5-XLM base
reserve, plus the classic transaction fee. Actual reserves, sponsorship,
thresholds, existing signers and fee quotes must be checked per account. No
Mainnet funding, signer change or irreversible key deletion is approved by this
design document.

## Game-input authorization

At stake authorization, the participant registers a client-held gameplay public
key bound to that exact contract, network, game, seat and staking account. Classic
account authorization must come from the player's valid signer, never a backend
custody fallback. The backend's designated administrator key cannot register or
replace another participant's gameplay credential.

The client signs compact hit/miss input batches or a full transcript. The signed
message binds game identity, seat, sequence, prior input commitment, payload hash
and completion. The Soroban contract validates that signature, reconstructs the
existing game rules and derives the score and winner itself. Temporary gameplay
keys avoid repetitive wallet prompts without granting treasury or withdrawal
permissions. Any participant-authorized credential recovery/rotation must
preserve already verified inputs and reject old-key replay.

VEX-7 inputs and score are deterministic contract calculations using the existing
profile and RNG; there is no authorized backend bot-score override. Missing
verified input scores zero at the contract-enforced deadline. No automatic
incomplete-transcript refund or new financial penalty is introduced.

## Recovery

Recovery uses a client-side authenticated-encryption envelope bound to the wallet,
network, public signer and version. Prefer a random recovery secret of at least
128 bits; derive a wrapping key with HKDF and a random salt, and use AES-256-GCM
with a fresh nonce. Human passwords require a reviewed slow password KDF and
strength controls rather than replacing a random secret with a weak password.

The server can store and deliver ciphertext after ordinary Google/X login. It
cannot unwrap the envelope, create a valid player input or reset the on-chain
signer by itself. Recovery runs in the browser, verifies the recovered public key,
and for a migrated account can authorize adding a new device signer while removing
a lost signer. Neither OAuth-account recovery nor an administrator API can restore
wallet control without the player's recovery secret or another valid player key.

Losing every player-held signer and recovery backup can permanently lock a secured
account. Backup creation and a local restore test are prerequisites for any
irreversible authority change; do not silently fall back to server custody.

## Backend, frontend and migration implications

- Preserve OAuth/provider identities and public wallet/profile records. Add a
  versioned vault/migration status, public signer data and encrypted recovery
  envelope without rewriting historical game addresses.
- Replace server-managed signing for Stellar inputs, stakes and wallet operations
  with prepared-envelope validation and client authorization. Preserve Freighter,
  xBull, LOBSTR, Albedo and Rabet; existing external-wallet keys stay with providers.
- Update account-message verification to respect current Stellar signer weights:
  a revoked master must not authenticate simply because its signature matches the
  historical account ID. A valid device/recovery signer may differ from the account
  address and must be checked against actual account authority.
- Preserve Stellar bridge functionality by accepting player-authorized envelopes;
  the separate Arc implementation is unchanged.
- Audit database/API permissions and deployments so legacy ciphertext and obsolete
  key-export handlers cannot restore application custody. Do not log secret values
  while auditing those boundaries.

This model assumes the player's wallet/browser signing code and device are trusted.
A server-held key cannot sign for the player, but malicious code executing on the
player's signing origin or a compromised device is a separate threat. Nonextractable
Web Crypto keys alone do not prevent same-origin code from requesting signatures.
The report must state this boundary; independently replaying legal inputs does not
attest physical human taps or make malicious frontend software trustworthy.

## Verification and approval gates

Develop on an isolated branch. Test client-only key creation and recovery,
wrong-wallet/network/password/ciphertext rejection, no backend plaintext access,
unchanged address/profile associations, old-key authorization rejection, exact
account migration operations, transcript signatures/sequences/replay and all game
and financial attack scenarios. Meter the compiled replay under actual Soroban
limits before selecting batching parameters.

A reversible, owner-only Testnet signing experiment can validate the design with
valueless assets and retained recovery. Existing production wallet signers, keys,
funds and configuration remain unchanged during development. Before any irreversible
migration or Mainnet deployment, present the full evidence and exact proposed
account/contract operations for the owner's explicit approval.
