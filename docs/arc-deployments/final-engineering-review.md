# Final Arc escrow engineering audit

Reviewed on 2026-11-22 by Codex against the source, compiler/dependency manifest,
constructor parameters and test evidence. The user explicitly approved the final
deployment after supplying the shared role address and stake limits. This is an
engineering audit; no independent third-party audit certification is claimed.

The approved escrow source is `contracts/arc/src/ChainDuelArc.sol` (SHA-256
`4cde6bc395152b2d060222655f137b066386767835b4ef246d31ee8892338c86`).
Creation bytecode, imported source hashes and constructor arguments are bound in
`approved-review-mainnet.json` and `prepared-mainnet.json`.

## Financial and authorization review

The official six-decimal USDC interface is independently verified on chain 5042.
The signer public address equals the user-designated shared address. The contract
accepts the same address as owner, settlement authority, protocol recipient,
ecosystem recipient and bot treasury. Stakes are bounded to 500,000–1,000,000,000
integer units. Maximum multiplication remains safely below uint256 limits.

PvP takes exactly two verified stakes. The winner receives the remainder after two
independent 500-BPS fee calculations, conserving every integer unit. Shared fee
recipients receive the aggregate 10%; the two 5% allocations remain separately
recorded. Bot liquidity is reserved at entry and accounted separately from player
escrow; bot wins restore only the payout to reserves. Administrative withdrawals
are limited to uncommitted bot reserves and the designated bot treasury.

Entry uses SafeERC20 plus an exact balance-delta check. Reentrancy guards protect
deposit, join, settlement, cancellation, refund and bot reserve movement. Terminal
state is written before external transfers. Failed transfers revert state and
accounting atomically. Reusing a settled/refunded game ID, double joining and
repeating settlement are rejected. Winner addresses must be participants.

Only the authority starts/settles games. Settlement needs a nonzero result hash,
a full 60-second match and a live recovery window. Owner pause blocks new entries
without trapping settlement/refunds. Expired waiting games and stalled active
games support permissionless refunds to the original participants. Ownership
changes use OpenZeppelin's two-step mechanism. Fee destinations are immutable.

## Evidence and deployment checks

- 16 Solidity tests passed, including 256 conservation/rounding fuzz cases,
  reentrancy, invalid transfer behavior, shared roles, exact stake limits,
  unauthorized settlement, replay, cancellations and timed recovery.
- 259 application tests, TypeScript, ESLint and optimized production build passed.
- 23 original Soroban tests and five funded Stellar Testnet flows passed.
- A real isolated PostgreSQL regression re-ran the original Stellar migrations
  after the Arc schema without altering its existing user record. Network history
  uses read queries and creates no views that block the original migrations.
- Deployment checks bind exact compiler/source/bytecode/constructor hashes,
  validate chain ID/token decimals and signer funding, save signed transaction
  bytes/hash before transmission, and verify the deployed role/token/stake fields.
- The independent Arc backend reserves authority nonces under a distributed
  lease and persists signed transactions before transmission. Concurrency,
  uncertain transmission, replaced nonce recovery and signature substitution
  tests passed. No Stellar signing logic was changed.

## Disclosed trust and operational limits

The settlement authority is trusted to execute the server's event-log replay and
submit its winner; the contract does not reproduce the arcade engine on chain.
Direct joins can bypass an app lobby, so the backend blocks mismatched participant
settlement and leaves refunds available. Token blocklisting can delay transfers.
Bot liquidity must be funded before a computer opponent can accept an entry.

Circle live key/App ID compatibility was verified. A user-controlled PIN setup
and signing challenge require the authenticated user's interaction. Live Google/X
and PIN/financial end-to-end checks must be reported separately. CCTP remains
disabled until both real transfer directions and destination recovery are tested.
Outstanding advisories in the preserved Stellar wallet dependency tree remain
documented in the security review. This audit does not certify those dependencies
or third-party wallet/bridge services.
