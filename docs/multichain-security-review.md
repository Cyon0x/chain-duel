# Multi-chain engineering security review

Review date: 2026-11-22. This records implementation checks. The required approved
financial-contract audit and real Circle/CCTP verification remain outstanding.

## Checks completed

- Preserved 117 original Stellar files byte-for-byte; no contract redeployment,
  environment replacement, destructive migration or original record reset.
- Session ownership and same-origin validation guard new financial APIs. Arc
  requests require the configured explicit network and USDC currency. Request
  parsing is bounded; unexpected provider errors are sanitized.
- Circle identities derive server-side from the authenticated application user.
  Upstream wallet owner, custody, chain and state are validated. Database uniqueness,
  reconciliation, stable idempotency keys and leases guard provisioning. Provider
  PIN/recovery secrets are handled exclusively by the official browser SDK.
- Arc contract entry/settlement uses integer units, exact token transfer checks,
  reentrancy guards, authorized state transitions, immutable fee destinations and
  terminal-game replay protection. Owner actions cannot withdraw player escrow.
- Game receipt verification binds sender, target, calldata, escrow game event and
  stake. Player funding is recorded once. Reverted operation/settlement hashes are
  archived before retry; unknown/pending hashes remain intact. External timed
  refunds reconcile against a successful contract event and receipt.
- CCTP records bind authenticated source/destination wallets. Attestation validation
  checks domains, token, messenger, owner, recipient, amount, maximum/executed fee,
  standard finality and Stellar forwarding hook. Saved message hashes/nonces cannot
  be replaced. A source success never marks a transfer complete.
- Signed Stellar bridge XDR/hash is stored before transmission. Uncertain source
  burns are retransmitted using identical bytes or left for recovery. Known failed
  non-burn steps retain archived attempts. Destination recovery checks the actual
  mint/forward transaction before completion.
- Arc deployment manifests validate compiler settings and every dependency source
  against compiled metadata, bind creation bytecode and constructor arguments to
  review approval, and reject signer files inside the repository.

## Verification evidence

- Application checks: TypeScript, ESLint and optimized Next.js build passed.
- 247 JavaScript tests passed; 15 opt-in live tests skipped.
- 23 unchanged Soroban tests passed.
- 15 Solidity tests passed, including 256 rounding/conservation fuzz cases.
- Browser regression passed the full 60-second Stellar demo multiplayer flow,
  onboarding, invitations, queue cancellation, authoritative scores/results,
  replay and sign-out. This exercises real application handlers with no-stake
  demo identities; it does not prove live social OAuth or Mainnet financial flows.
- Responsive scans and existing cross-platform matrices have no mechanical FAILs.

## Release limitations

Circle credentials were absent, so live Google/X wallet provisioning, signing,
recovery, Arc escrow deposits/payouts and both CCTP transfer directions could not
be verified. They remain disabled by independent activation checks.

The escrow requires the configured authority to report the replayed game result.
Direct on-chain joins can bypass app matchmaking; the backend blocks mismatched
participant settlement and exposes timed refunds. These trust and recovery
properties need inclusion in the financial-contract audit.

Arc blocklist/token restrictions can delay transfers/refunds; gas requirements,
RPC uncertainty, exhausted bot reserves and unavailable attestations are surfaced
as unavailable/pending/recovery states. No guaranteed settlement-time claim is made.

Current production-dependency audit: 28 advisories (12 low, 6 moderate, 10 high,
0 critical). The outstanding high advisories originate in the existing Stellar
wallet-kit/Reown tree and its nested dependencies, including follow-redirects and
Zod. Shared Next.js and direct Zod plus scoped Circle transitive dependencies were
patched. Further Stellar dependency upgrades require separate regression work
under the preservation constraint. This release does not claim a clean dependency
audit or an independent contract certification.

The production application previously used Stellar Testnet with its original
90/10 economics. Mainnet Stellar gaming is unavailable in that audited deployment
and is not silently activated by this expansion.
