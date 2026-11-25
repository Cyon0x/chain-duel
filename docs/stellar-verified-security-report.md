# Independently verified Stellar Pulse candidate

Mainnet remains blocked pending owner review and explicit approval of the new
architecture and each irreversible player-authority migration. The earlier
signed-score candidate was never deployed to Mainnet. Testnet deployment does not
complete the custody cutover or authorize production launch.

## Original vulnerability and regression evidence

The historical `contracts/chain_duel/` contract trusted administrator-supplied
scores. The earlier candidate checked supplied-score/combo consistency and a
nonzero result hash, but an administrator could still invent a result. The
witness `audit_witness_the_authorized_score_oracle_is_not_a_gameplay_proof` is
preserved in `stellar-verified-deployments/legacy-score-audit.rs.txt`.

The replacement `contracts/chain_duel_mainnet/` accepts no score, winner, combo,
bot transcript or fee parameters at settlement. The linked `pulse_replay` library
reconstructs target generation and replays every legal participant-signed input.
Settlement reads only that verified state and the contract-generated VEX-7 result.
No administrative result override exists.

Testnet escrow:
`CCBSSZQ34DSSLHSLUSK6DHGPM6RFXJBHZY6ZELHEE2UJJFDQ2SHZYNT5`.

Artifact SHA-256:
`9459f853992e8d59d9c2e74f404f6556205f515d09681c711f7200827b64c59f`.

The RPC/Horizon receipts in `stellar-verified-deployments/testnet-evidence.json`
include failed transactions for:

- Forged player signature:
  `deb3ad4a24d9a3865c209fafe600f257eb8b61712b39cd69947308f615161926`.
- Original fabricated-result ABI attack:
  `15663b14c2fb1abc10469fd3e22e7f17c97647620460e82d796b376d9bdcd142`.
- Unauthorized fee withdrawal:
  `884ce3f1ba01ceff02000fc77ac0437ab99c9f4e72ea528529eb903b2caa3647`.

The failed result/signature calls left active-game escrow unchanged. Native tests
also cover invalid signed transitions, replay across games/networks/seats, sequence
conflicts, future timestamps, deadlines, combos, duplicate settlement, unauthorized
key rotation and atomic payout rollback. Application tests reject backend score
fabrication and inconsistent receipts before writing winnings/statistics.

## Exact rules and timing

The existing 60-second simultaneous Pulse game, 3.2-second countdown, target RNG,
70ms reaction floor, scoring, multipliers, VEX-7 and score/combo/seat-1 tie-break
remain unchanged. Software IEEE-754 reproduces JavaScript arithmetic. 192 unchanged
engine reference games establish schedule/human/bot parity, including longer
120/300-second stress fixtures that do not change production game duration.

Ledger time determines countdown base, play start, end and input deadline. A
10-second confirmation buffer precedes the existing countdown. The deadline is
countdown-base +80 seconds, preserving the original abandonment window. Before
the deadline, all human inputs must be closed; afterward anyone can settle.
Accepted partial inputs count; missing input scores zero. Withholding a transcript
cannot force an automatic refund or block settlement. Signature domains bind
game, contract, network, seat, credential epoch, event offset, prior commitment,
clock parameters and exact payload hash.

## Fees and liabilities

The only external administrator, treasury and both fee recipients/beneficiaries
are the existing wallet:
`GCQKVXWIQHVGUOUHZR2O6YBWBNNPKIYH5AWQHXHF3EYRHM73WIWVSK7K`.
The shortened address ending `SK7` is invalid. No replacement administrator or
deployment account was created and its signers were not changed.

A 100-USDC pot pays 90 to the legitimate winner, accrues 5 protocol and 5 ecosystem
fees, both owned by the designated wallet. Fees are separately accounted on-chain;
each withdrawal requires that wallet. Rates/recipients cannot be arbitrarily
changed. Controlled Testnet receipts prove 12.5 USDC from each fee allocation
reached that wallet across four settled games.

Player liabilities, fee buckets and free computer liquidity are distinct. Fee
withdrawals cannot consume escrow or the other allocation. Bot withdrawals
preserve the existing 100-unit free reserve. Shared withdrawal IDs reject reuse.
Pre-start cancellation/expiry refunds return to depositors. Pause preserves active
inputs, settlement and eligible refunds. Payout failure rolls back settlement and
both fee buckets. No upgrade, arbitrary-transfer, unrestricted emergency extraction
or administrator winner override entry point exists.

## Player custody and migration

New client-mode social wallets are generated in the browser. A nonextractable
Ed25519 key stays in IndexedDB. The server stores public metadata and a
HKDF-SHA256/AES-256-GCM encrypted backup wrapped by a player-held 192-bit recovery
code. Recovery runs locally, verifies the public key and preserves the address.
Google/X identities, profiles and external wallet providers remain.

Existing managed master keys have historically been known to the backend.
Disabling decryption does not revoke historical copies. Their addresses are
preserved by adding independently confirmed player device/recovery signers,
setting thresholds to one and revoking the old master weight. An unsigned plan
checks authority, reserves and outstanding games/transactions. No application
endpoint executes that irreversible transition.

Backend sessions and possession proofs for new keys cannot establish that the
real player selected those keys. Each legacy migration needs an independently
confirmed, approved per-wallet manifest outside the game backend. Until its
execution and authority verification, managed wallets are blocked from verified
stakes. The designated administrator is excluded from player signer migration.

Client mode blocks `loadWalletKey`, `openSecret`, server key generation and player
key signing. Stakes, wallet sends and Stellar bridge steps require client-signed
envelopes. Authentication checks actual signer weight, rejecting a revoked master.
The isolated Preview uses no valid legacy player decryption credential. Original
production signers, encrypted keys and configuration remain untouched. Controlled
owner Testnet transactions do not prove that production custody was revoked.

## Remaining boundaries and release conditions

- A participant signature authorizes legal input; it does not prove a physical
  human tap. A player can automate legal play or sign backdated legal events
  before the deadline. No human-presence or anti-bot attestation is claimed.
- The signing origin and player device must be trusted. Compromised same-origin
  JavaScript could request signatures even from nonextractable keys. Browser key
  custody alone does not solve malicious hosted-code delivery.
- Client pins and independent RPC reads establish contract/WASM/rules/game state.
  Direct inputs and permissionless settlement reduce backend withholding risk;
  outages, congestion and inadequate XLM can still cause missed deadlines.
- Historical backend-held masters remain valid until separately approved on-chain
  revocation. Complete that ceremony and remove legacy decryption credentials and
  data access before claiming production player custody has changed.
- The complete provider-by-provider Freighter/xBull/LOBSTR/Albedo/Rabet interactive
  signing campaign and live Google/X OAuth/recovery ceremonies remain release checks.
- Rent is material: Testnet upload/deployment spent 41.5399424 XLM, exceeding the
  provisional initialization estimate. Re-simulate Mainnet fees and review its
  expenditure cap; the prior 40-XLM signed-score plan is obsolete.
- Include state TTL/restoration, monitoring, fee sponsorship and funding in the
  production runbook. There is no general administrator recovery of player funds.

The final report must distinguish Testnet evidence, application/browser evidence
and approval gates. Until critical release/custody checks are complete, the verdict
is **NOT READY: SECURITY OR FUNCTIONALITY ISSUES REMAIN**.

## November 25 resumed verification

The build reproduces the pinned 39,385-byte WASM exactly. The resumed application
suite passes 350 tests, with 17 opt-in checks skipped. The isolated live PostgreSQL
Stellar/Arc migration checks pass separately. Native validation passes 32 escrow,
5 replay and 23 legacy escrow tests, plus the compiled escrow resource probe;
the unchanged Arc contract passes all 16 tests. Type checking, lint and the
production build pass.

The browser campaign exposed two integration defects that unit score tests
could not detect: SDK 17's RPC constructor ignores its timeout option, and
Protocol 30's live event response omits the legacy `inSuccessfulContractCall`
flag. RPC timeouts now apply to the actual HTTP transport. The client verifies
immutable rules once per pinned deployment, reads each current game independently
and coalesces overlapping match polls. Receipts accept the omitted flag only
with an independently confirmed successful transaction at the exact expected
ledger; explicit failed events, failed/missing transactions and wrong ledgers
remain rejected. Eight dedicated transport/receipt regression checks pass.

The interrupted browser duel was already settled on-chain: player one had 16
verified hits and 190 points; player two had zero. Its settlement is
`4b99ad13bfdd58cc6346d820103eaf972955c8d03f2c7f482d2e84eb15717f83`.
The fixed application recovered the existing receipt, awarded 45 Testnet USDC
from a 50-USDC pot, and recorded two 2.5-USDC fee allocations without another
stake or payout. The earlier expired invitation was refunded through its
eligible on-chain path. The browser harness now preserves confirmed funding and
reconciles saved games before any financial retry.

The read-only production audit in
`stellar-verified-deployments/production-associations-after.json` reproduces
the earlier wallet-association and encrypted-key fingerprints, with the same
99 users, 99 wallets, 91 key records and 66 games. Mainnet configuration and
player signing authority have not been migrated.
