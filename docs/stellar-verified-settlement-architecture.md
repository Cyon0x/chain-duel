# Independent Stellar game verification — architecture investigation

Status: controlled Testnet implementation and automated validation complete. No Mainnet deployment
is authorized until the owner reviews the new implementation and explicitly approves
it. The earlier signed-score WASM and its prepared Mainnet address are superseded
before signing; no Mainnet deployment or initialization transaction was submitted.

## Designated wallet and fee arrangement

The valid, existing 56-character address is
`GCQKVXWIQHVGUOUHZR2O6YBWBNNPKIYH5AWQHXHF3EYRHM73WIWVSK7K`.
The Phase 5 address ending `VSK7` is missing its final `K` and fails Stellar's
address checksum/length validation. It is not a second wallet or a usable fee
destination. No deployment/admin replacement wallet will be created.

Winner: 90%; protocol: 5%; ecosystem accounting: 5%. Both fee allocations belong
to the designated wallet, as explicitly instructed. The contract calculates the
amounts and preserves separate allocation accounting; their combined destination
is the same wallet. Fees never include active stakes or unpaid player winnings.

## Existing game and trust boundary

Chain Duel is Pulse Duel: both players tap the same deterministic target stream
simultaneously for 60 seconds. It has no alternating board-game turns or draw
refund: scores break ties by maximum combo and then seat 1. These mechanics must
remain intact. Input ownership means the correct participant/seat, not inventing
a new turn-based game.

The actual rules reside in:

- `src/lib/config/game.ts`: 60-second duration, 3.2-second countdown, 1.25 pace,
  blue/gold/red points, spawn/lifetime rules, combo tiers, VEX-7 skill profile,
  stake bounds, fee rate and treasury reserve.
- `src/lib/game/rng.ts`: UTF-16 FNV-1a seed hash and Mulberry32 stream.
- `src/lib/game/pulse.ts`: schedule, legal hit/miss processing, reaction floor,
  duplicate target rejection, expiry, combo timing and scoring.
- `src/lib/game/bot.ts`: deterministic VEX-7 input generation and engine replay.
- `src/lib/game/verify.ts`: submitted transcript validation and replay. Existing
  limits are 4,000 total events and 1,500 hits; actual schedules have far fewer
  hittable targets. Hits and misses are merged by timestamp with stable hit-first
  ordering when timestamps are equal.

`src/components/game/arena.tsx` plays locally, stores hit/miss logs, shows live
scores and submits the final log. Progress updates contain provisional numbers
and are deliberately excluded from settlement. `src/lib/services/match.ts` replays
the transcript, calculates VEX-7's score, selects a winner and records ratings,
profiles and history. Its existing abandoned-game sweep settles after duration
plus 20 seconds from the stored countdown base; missing final results have their
existing zero score. There is no active-game on-chain timeout refund today.

`src/lib/services/escrow.ts`, `src/lib/stellar/contract.ts` and
`src/lib/stellar/server.ts` turn the selected scores/winner into an administrator-
signed `settle_game` call. The legacy contract and the first Mainnet candidate
cannot reconstruct the game. The candidate checks internally consistent supplied
scores, a nonzero hash and the administrator's signature, then releases escrow.
Those checks accept the documented fabricated computer win in
`docs/stellar-mainnet-security-review.md`.

On-chain today: deposits, equal stakes, game lifecycle flags, bot liquidity,
supplied-score settlement, payout/fee accounting, cancellation/expiry refunds and
administrative withdrawals/configuration. Off-chain today: target generation,
inputs, all score calculation, computer play, gameplay timing, terminal decisions,
winner selection and transcript provenance.

## Functions influencing funds or outcomes

| Component | Functions and authority |
| --- | --- |
| Pulse engine | `hashSeed`, `mulberry32`, `buildTargetSchedule`, `applyHit`, `applyMiss`, `comboMultiplier`, `scoreMatch` |
| Computer | `PulseBot` plan/update, `simulateBotMatch`, configured VEX-7 parameters |
| Backend match | `startMatch`, `submitResult`, `finalizeBotMatch`, `winnerOf`, `settleMatch`, `resultHashFor`, `ensureSettlementForExpiredMatches`, `applySettlement` |
| Backend escrow | `lockEntry`, `lockJoin`, `submitWalletSigned`, `beginOnChainGame`, `settleOnChain`, refund/withdrawal wrappers |
| Soroban escrow | `create_game`, `join_game`, `start_game`, `settle_game`, `cancel_game`, `claim_refund`, `fund_bot_pool`, fee/liquidity withdrawals, pause/bot/limit/fee configuration |
| Signing/custody | `signerForUser`, `generateManagedWallet`, `openSecret`, `managedKeypair`, `settlementKeypair`, `prepareInvocation`, `invokeWithServerKey`, durable signing intents |
| Social accounts | `signInWithProvider`, `provisionManagedWallet`, existing encrypted wallet-key associations |

## Required independent verification architecture

1. Pin the existing Pulse rules and reproduce their deterministic schedule and
   VEX-7 engine inside Rust. Soroban must derive scores from legal input events;
   no external winner, score, combo, fee amount or final board can authorize funds.
2. Bind each participant's input authorization to the escrowed game and seat.
   A temporary gameplay signing credential may avoid repeated wallet prompts,
   but must be registered by the actual participant and immutable for that game.
   It is a gameplay credential, not another deployment/admin wallet.
3. Bind authenticated input bytes to the contract/network, game, seat, sequence,
   previous transcript commitment and completion flag. Reject forged credentials,
   altered bytes, invalid targets/timestamps, duplicates, replay and sequencing
   conflicts atomically before storing a verified transition.
4. Start/end/deadline derive from contract state and Stellar ledger time. The
   backend can coordinate and sponsor calls, but cannot choose a terminal result.
   Permissionless completion calculates the winner from independently verified
   inputs and the contract-generated computer score after the game clock ends.
5. Keep winner payout and the two internally calculated fee allocations atomic.
   Administrative withdrawals remain capped by separate earned-fee/free-liquidity
   buckets; locked escrow remains inaccessible. Pause must not prevent valid
   settlement or eligible depositor refunds.
6. Verify receipt/state before writing local money/history/statistics. Existing
   Testnet games retain their original contract/network/currency and recovery.
   Arc remains a separate, unchanged implementation.

## Execution options to measure before choosing limits

| Approach | Consequences |
| --- | --- |
| Transaction for every tap | Direct sequence anchoring, but wallet prompts, fees and several-second ledgers obstruct the existing real-time experience. |
| Authenticated input batches | Compact verified state and bounded replay; temporary participant credentials avoid in-game prompts. Input delivery/deadline rules must be explicit. |
| Complete authenticated transcripts | Lowest call count and compact stored commitments; the contract still reconstructs every input and VEX-7 result. Worst-case 4,000-event inputs must fit execution and envelope limits. Missing-input handling cannot rely on the backend. |

The JavaScript schedule uses cumulative IEEE-754 arithmetic, including density
pressure, not just integer timestamps. Replacing it with approximate fixed-point
math can change spawn times and bot outcomes. Investigate deterministic software
IEEE-754 arithmetic, differential vectors and actual compiled-WASM metering before
claiming parity. Keep the production 60-second rules; longer-duration engine stress
tests are measurements, not permission to change the game duration.

## Owner decisions and remaining approval boundary

- The owner chose player-controlled signing with secure recovery while preserving
  Google/X login and existing wallet addresses. The concrete design is documented
  in `stellar-player-controlled-signing.md`. No existing wallet signers or encrypted
  keys have been changed; irreversible migrations need a later explicit approval.
- The owner chose the existing zero-score treatment for missing verified input
  by a deterministic deadline. Withholding a transcript must not prevent settlement.
  No incomplete-game refunds or new penalties are authorized.
- Even independent game-rule verification does not prove a physical human tap.
  The security claim concerns authorized legal game inputs, independently derived
  state/outcomes and protected escrow, not hardware-attested human activity.

## Required evidence before Mainnet security review

Engine/schedule/VEX-7 parity; legal and hostile input tests; the original fabricated-
result attack must fail; actual participant authorization; replay/sequence/timeout
cases; payout/fee conservation and withdrawal denial; realistic/worst-case WASM
CPU, memory, storage, transaction size and fee measurements; controlled-wallet
Testnet deployments and complete games with independent receipt verification;
frontend/backend/wallet/auth/history tests; a complete security/financial report.

Until these succeed, the verdict is **NOT READY: SECURITY OR FUNCTIONALITY ISSUES
REMAIN**. Funding the designated Mainnet wallet does not approve the old oracle or
the new architecture's Mainnet launch.
