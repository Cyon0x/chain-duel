# Security

> **Never trust the frontend.** The frontend can *request* actions; the backend and the Soroban
> contract must *verify* them.

This document is the threat model and the corresponding mitigations, with pointers to the code
and tests that enforce them.

## Trust boundaries

| Boundary | Rule |
| --- | --- |
| Browser → API | Every route re-validates input with `zod`/explicit checks and re-checks the session and ownership. No route trusts an id, amount, seat, score or winner supplied by the client. |
| API → contract | The contract independently enforces amounts, state transitions, winner validity, authorization and payout destination. A bug in the API cannot move funds to an unapproved address. |
| Contract → treasury | `withdraw_treasury` / `withdraw_bot_liquidity` are `require_admin` and can only send to the configured treasury address. |
| Server → secrets | The settlement key and managed-wallet keys exist only in server memory. |

## Asset-specific controls

### Game results

- The client submits an **event log** (target ids + timestamps), never a score.
- `verifySubmission` replays the log through the same deterministic engine and rejects:
  `hit_unknown_target`, `duplicate_hit_target`, `hit_before_target_spawn` (faster than the 70 ms
  reaction floor), `hit_after_target_expiry`, `event_after_match_end`, `implausible_hit_count`,
  `event_log_too_large`, `score_above_theoretical_max`, `rejected_events_present`,
  `client_score_mismatch`, `invalid_seat`.
- Rejections are recorded as `submission_rejected` game events for later analysis.
- Both players receive the same seed, so neither can be handed an easier target stream.

### Settlement

- `settlement_status` compare-and-set (`null|failed → submitting`) means exactly one caller can
  settle a game. Duplicate submits and retries are no-ops.
- The settlement hash is persisted **before** local bookkeeping, so a retry after a failed local
  write resumes without paying on chain twice.
- All derived state (statistics, rating, reputation, ledger rows, final status) is written in one
  database transaction, so a partial failure rolls back instead of producing inconsistent balances.
- `demo` duels move no money and never affect rating.

### Replay and duplicate payment

- SIWS challenges are single-use rows in `stellar_nonces` with an expiry and `consumed_at`.
- A seat that has already locked its entry returns the original transaction on retry rather than
  invoking the contract again (no double charge, no raw contract error after funds moved).
- Invite codes are 6 characters drawn from a 32-symbol alphabet using `crypto.getRandomValues` —
  not sequential, not enumerable in practice.
- Queue tickets are claimed with a status transition, so two players matching simultaneously
  cannot both create the game.

### Treasury and admin

- Admin is identified by the configured `ADMIN_WALLET_ADDRESS`; `/admin/treasury` returns 404 to
  everyone else, and every action additionally calls `requireAdmin()` server-side **and**
  `require_admin()` in the contract.
- Withdrawal destination is hard-bound to the treasury wallet: there is no destination parameter
  to tamper with.
- Limits: `MIN_TREASURY_BALANCE` 100 XLM, `MAX_BOT_ENTRY` 25 XLM, `MAX_PAYOUT` 250 XLM,
  `DAILY_BOT_LIABILITY` 1000 XLM. Exceeding them disables bot matches instead of risking a
  negative treasury.
- Every treasury withdrawal, deposit, config change and pause is written to `admin_actions` /
  `treasury_transactions` with the admin wallet, action, timestamp and transaction id.

### Tested denials

The contract suite asserts that unauthorized withdrawal fails for: player A, player B, a random
wallet, an unauthenticated caller and an invalid signature — and that it succeeds for the
designated admin, sending funds to the treasury address only. `tests/security.test.ts` and
`tests/duel-flow.test.ts` cover admin denial, replay and tamper cases at the API layer.

### Private keys

Never present in: frontend code, git, public env vars, `localStorage`, API responses, logs.

- Managed-wallet secrets are generated server-side and stored only as AES-256-GCM ciphertext in
  `wallet_keys`, decrypted only inside the signing service.
- The settlement/admin key lives in a server-only env var; the browser never sees it.
- `.env*` is gitignored, and `.env.local` is written with mode `0600`.

### Authentication

- SIWS: one-time challenge bound to the configured domain, ed25519 signature verification, expiry
  and single use.
- OAuth: authorization-code flow with PKCE (S256), a `state` cookie validated on callback, and
  `id_token` verification against the provider's JWKS. No token is trusted without verification.
- Sessions: stateless JWTs in `httpOnly`, `sameSite=lax`, `secure`-in-production cookies.
- Account merging is by (provider, provider account id) and by wallet address, so refreshing,
  expiring a session or switching accounts cannot silently create or lose a profile.

### Input handling

- Usernames: `^[a-zA-Z0-9_]{3,18}$` with a reserved-name list; avatar and theme are validated
  against a fixed set before they are stored or rendered.
- Amounts are validated as integers in stroops against on-chain limits before any transaction is
  built; NaN/negative/oversized values are rejected.
- Rendering is React text interpolation; no `dangerouslySetInnerHTML` anywhere in the app.

### Error honesty

- A transaction is only ever displayed as confirmed after Stellar confirms it.
- Failures mark rows `failed` with a human-readable message; a settlement that has not confirmed
  stays pending. Nothing is optimistically marked successful.

## Operational notes

- Rotate `SETTLEMENT_SECRET_KEY`, `SESSION_SECRET` and `WALLET_ENCRYPTION_KEY` per environment;
  never reuse the development values in production (the app refuses to boot in production without
  strong secrets).
- The admin wallet is a hot key by design for Testnet settlement. For production, move settlement
  to a KMS/HSM-backed signer behind the same `invokeWithServerKey` interface.

