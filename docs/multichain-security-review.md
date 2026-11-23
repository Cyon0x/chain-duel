# Multi-chain engineering security review

Review date: 2026-11-22. This records implementation checks. The final escrow
engineering audit and user-approved Mainnet deployment are recorded in
`arc-deployments`; no independent third-party audit is claimed. Live Circle PIN signing, staking, settlement and refund passed owner validation.
Both live CCTP directions and destination receipts were verified on 2026-11-23.
PIN recovery remains a separate owner check.

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
- Circle challenges pin the verified absolute fee quote and require native USDC
  balance for the stake/burn plus maximum gas reserve before signing. Regression
  checks cover the observed underfunded deposit, funded retry and gas-only refund.
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
- 264 JavaScript tests passed; 16 opt-in tests skipped in the default run.
- 23 unchanged Soroban tests passed.
- 16 Solidity tests passed, including 256 rounding/conservation fuzz cases and
  the approved shared roles and stake limits.
- Five funded Stellar Testnet regression flows passed. A real isolated PostgreSQL
  regression passed after applying Arc migrations and re-running the original
  migrations, confirming compatibility and preserved user records.
- Arc authority transactions use a distributed signer lease, durable nonce
  reservation and signed outbox. Concurrent games allocate different nonces,
  uncertain submissions reuse signed bytes, and replaced nonces require definitive
  chain evidence. Signature substitution is rejected before transmission.
- Dedicated Arc Google/X clients use PKCE and isolated callback/cookie namespaces,
  without changing the existing Stellar clients. Google audience/issuer/nonce
  verification and X user-context identity checks passed. Live token-endpoint
  configuration probes did not reject either supplied client; these probes do not
  establish a completed user login or Circle PIN setup.
- Browser regression passed the full 60-second Stellar demo multiplayer flow,
  onboarding, invitations, queue cancellation, authoritative scores/results,
  replay and sign-out. This exercises real application handlers with no-stake
  demo identities; it does not prove live social OAuth or Mainnet financial flows.
- Responsive scans and existing cross-platform matrices have no mechanical FAILs.
- Follow-up verification on 2026-11-23 passed 276 application tests, TypeScript,
  ESLint, the optimized build, both contract suites and the isolated PostgreSQL
  migration regression; all 117 protected Stellar files remain unchanged.
- The live 0.10 USDC Arc-to-Stellar transfer matches the actual source allowance,
  wallet-to-local-minter funding, minter burn, emitted CCTP message, Circle
  attestation, exact Stellar mint-and-forward invocation and official destination
  USDC credit. Repeated refresh preserves all completed receipt references.
  The return's owner-approved Stellar allowance/burn envelopes match the persisted
  signed bytes and exact invocation. The official USDC debit and emitted message
  match the saved intent and Circle attestation. The final Arc receipt verifies
  the exact transmitter calldata, MessageReceived, consumed nonce and 100,000
  six-decimal USDC mint. Its native balance change reconciles with the mint less
  actual gas. Verification and preparation did not execute a financial transaction.
- Expired Arc allowance approvals are archived before a new challenge is prepared;
  expired burn attempts remain terminal and require a new reviewed transfer.
  Regression tests verify both behaviors. The mint UI passed 18 local browser
  cases for ready, waiting, submitted, failed-retry and completed states without
  authorization, page errors or horizontal overflow.
- Live release probes verified the Circle gas quote, blocked a full-wallet debit
  that cannot reserve gas, observed the owner's prior expired Circle authorization,
  and verified idempotent confirmed approvals. Destination recovery accepts the
  actual mint hash and rejects an unrelated transaction. Forty-two focused bridge,
  configuration and routing tests passed again; all protected Stellar files remain
  unchanged. These checks justify the reviewed public-release flags.

## Release limitations

The supplied Circle live key authenticated and matched the supplied App ID.
Live Google registration, Circle wallet creation, PIN signing, Mainnet staking,
bot settlement, both 0.05 USDC fee transfers and full-stake cancellation/refund
passed owner validation. Live X registration, PIN recovery, a human-winning
payment remain separate owner checks. Both CCTP directions, live PIN signing,
destination settlement and recovery passed. Public bridging is verified for
release; its activation is recorded in the release report. The initial
owner-only validation exception remains excluded from Production.
The Arc escrow was deployed with the approved parameters and its creation/runtime
bytecode verified exactly by Sourcify. Activation status is recorded in the release report.

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
