# Stellar Mainnet security review — launch blocked

> Historical signed-score audit, retained as the requested attack baseline.
> The replacement independently verified implementation, actual Testnet attack
> receipts and remaining custody/release boundaries are documented in
> [stellar-verified-security-report.md](stellar-verified-security-report.md).
> Statements below about the original candidate and absent live testing describe
> the pre-upgrade state. Mainnet remains undeployed and approval-gated.

The owner has now required independent contract-level gameplay verification and
Testnet-first validation. Retaining the trusted backend is no longer an accepted
launch option. The earlier signed-score candidate remains undeployed. The new
architecture investigation is in `stellar-verified-settlement-architecture.md`;
Mainnet deployment requires a later explicit owner approval after that review.

Designated deployment and administrative wallet:
`GCQKVXWIQHVGUOUHZR2O6YBWBNNPKIYH5AWQHXHF3EYRHM73WIWVSK7K`.
The owner explicitly approved this wallet receiving both fee allocations and
holding the ecosystem allocation. No replacement deployment wallet was created.

## Settlement trust boundary requiring resolution

The existing game verifies player event logs in `src/lib/game/verify.ts` and
signs settlement through the backend. The Mainnet revision preserves that
architecture and checks the winner against supplied scores, maximum combos and
the existing seat tie break. It requires the designated wallet's authorization,
an active game, a nonzero result hash and a previously unsettled game.

Those checks do **not** prove that supplied scores came from real gameplay.
An administrator controlling the signing key can sign a fabricated result outside
the normal backend. The contract cannot distinguish it from the backend's honest
attestation. For a computer game, declaring a computer win pays the designated
treasury wallet 90% of the pot.

The reproducible Soroban test
`audit_witness_the_authorized_score_oracle_is_not_a_gameplay_proof` demonstrates
this using simulated assets: a 50-unit pot pays 45 to the administrator after
accepting scores 0 and 1 and a nonzero hash, without a gameplay proof. A passing
witness documents this limitation; it is not a security success.

Consequently, this revision cannot satisfy an absolute requirement that even the
administrator cannot fabricate a game payout. Mainnet activation remains blocked.
The investigation originally presented these choices:

- Retain the existing trusted verifier only if the owner explicitly accepts that
  trust boundary. Continue to protect stakes from fee and liquidity withdrawals,
  and complete all live financial and application tests before public activation.
- Require a gameplay proof independently checked by the contract before launch.
  This needs a separately reviewed verifier implementation preserving the existing
  game rules. Adding another ordinary administrator key does not solve the issue.
  Requiring player settlement signatures changes the signing flow and must receive
  owner approval; server-held managed player keys would remain a custody boundary.

No existing contract was upgraded, no existing funds were withdrawn, and no live
USDC test was executed to work around this limitation.

## Controls demonstrated by offline tests

- Atomic constructor initialization; administrator, treasury and both recipients
  are the same wallet. Token, recipients and administrator cannot be rotated.
- Independent protocol/ecosystem fee buckets with per-game fee snapshots.
- Checked integer accounting and conservation across 256 varied games.
- Fee withdrawals are capped by their bucket and cannot consume locked stakes,
  the other fee allocation or uncommitted bot liquidity.
- Withdrawal IDs are consumed atomically across buckets to reject replay.
- Duplicate settlement, outsider winners and inconsistent score winners fail.
- Later payout-limit changes cannot freeze already committed player payouts.
- Cancellation and expiry refunds return only to depositors; pausing blocks new
  stakes while preserving settlement and eligible refunds.
- Ordinary player signatures cannot reserve a game ID or seat without the
  application's designated administrator approval.

## Other boundaries

Official USDC identity is established from Circle's documented issuer, canonical
Mainnet SAC derivation and on-chain name, symbol and seven-decimal precision.
Circle controls token issuance and delegated token administration; those powers
are separate from Chain Duel's administrative authority.

Managed wallets remain server-signed and encrypted using the existing key. This
preserves Google/X wallet associations, but is a custody trust boundary. External
wallet private keys remain with their wallet providers. No key belongs in public
configuration, logs, reports, Git or frontend bundles.

Persistent contract state can be archived after its network lifetime. Archived
state must be restored and its fees simulated before further writes. Active
games cannot be confiscated through an emergency withdrawal. The existing
architecture requires a functioning authorized verifier to settle active games.

## Verification status

Offline evidence is distinct from Mainnet deployment and live financial evidence.
At the time this review was written, the designated account and official USDC had
been read independently from Mainnet; the new escrow had not been deployed or
initialized, and wallet-provider/live-game financial tests remained outstanding.
Final readiness must be **NOT READY: BLOCKING ISSUES REMAIN** until these are
resolved and all three requested verification passes succeed.
