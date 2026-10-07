# Chain Duel

**Compete. React. Duel.**

Chain Duel is a premium 1v1 skill-based arcade game. The first mode, **Pulse Duel**, is a
60-second reaction game: two players get the *same* deterministic target stream and race to
out-score each other. Entries are escrowed on **Stellar Testnet** by a **Soroban** contract, and
settlement pays the winner from escrow — the protocol never holds player funds in a hot wallet
during a duel.

It is a game with a wallet, not a dashboard with a game attached.

- Gameplay (targets, hits, combos, timer) runs off-chain and stays fast.
- Money (entry, escrow, settlement, refunds, protocol fee, bot treasury) is on-chain and auditable.

---

## Table of contents

- [Live Testnet deployment](#live-testnet-deployment)
- [How the game works](#how-the-game-works)
- [Audio & soundtrack](#audio--soundtrack)
- [Architecture](#architecture)
- [Stellar integration](#stellar-integration)
- [Soroban escrow contract](#soroban-escrow-contract)
- [Authentication & wallets](#authentication--wallets)
- [Matchmaking, invites and challenges](#matchmaking-invites-and-challenges)
- [Computer opponent (bot mode)](#computer-opponent-bot-mode)
- [Protocol treasury & admin](#protocol-treasury--admin)
- [Database](#database)
- [Local setup](#local-setup)
- [Testnet setup](#testnet-setup)
- [Deployment](#deployment)
- [Testing](#testing)
- [Security](#security)
- [Known limitations](#known-limitations)

---

## Live Testnet deployment

| | |
| --- | --- |
| Network | Stellar Testnet (`Test SDF Network ; September 2015`) |
| Escrow contract | `CBBDWEWBBQVQXNYUJ4FA6C2CXXUVDAJSNUOVPZNKTQWK5P2EON7KEGMZ` |
| XLM token (SAC) | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| Admin / treasury wallet | `GCQKVXWIQHVGUOUHZR2O6YBWBNNPKIYH5AWQHXHF3EYRHM73WIWVSK7K` |
| Explorer | https://stellar.expert/explorer/testnet/contract/CBBDWEWBBQVQXNYUJ4FA6C2CXXUVDAJSNUOVPZNKTQWK5P2EON7KEGMZ |

The contract is live, the bot treasury is funded with real Testnet XLM, and a full
escrow → settlement → payout cycle has been executed on-chain (see [Testing](#testing)).

> Testnet XLM has no real-world value. Do not treat this deployment as real-money.

> **Contract revision note.** The deployed instance above was built from the revision in which
> `admin` and `treasury` were a single address. Current `main` splits them (see
> [docs/stellar.md](docs/stellar.md)): `admin` settles games, `treasury` is the sole withdrawal
> authority and destination. The split only takes effect on the next `npm run stellar:deploy`; the
> live deployment behaves identically because its `admin` and `treasury` are the same wallet.

---

## How the game works

### Pulse Duel

- 60-second match, both players see the same deterministic target sequence (`seed` is generated
  server-side and stored on the game row).
- Pace is set by `PULSE_SPEED_MULTIPLIER` in `src/lib/config/game.ts`: **1.25×**, so targets spawn,
  expire and roll the combo window 25% faster than the original baseline. Match length, target mix,
  point values and combo tiers are unchanged.
- Targets:
  - **Blue** +10
  - **Gold** +25
  - **Red** −15
- Combos: 3 hits → `1.2x`, 5 hits → `1.5x`, 8 hits → `2x`, broken by a miss or a red target.
- Both players play the same clock, anchored on the server's `started_at`.

### Entry economy (defaults, all configurable)

| | |
| --- | --- |
| Entry (each side) | 5 XLM |
| Prize pool | 10 XLM |
| Protocol fee | 10% (1000 BPS, hard ceiling 30%) |
| Winner reward | 9 XLM |
| Protocol | 1 XLM |

Ranges: entry 1–100 XLM (`max_entry` 25 XLM on-chain for bot matches), max payout 250 XLM.

### Reading the result

`src/lib/game/outcome.ts` is the single place WIN / LOSE / DRAW is decided, and it only reads a game
once settlement has written it (`status: "settled"`). A game briefly sits at `status: "finished"`
while the settlement transaction confirms — that intermediate row has no winner yet, so the UI shows
a "settling" state and keeps polling rather than guessing. This is what previously let a loss render
as "DRAW" until the page was refreshed.

### Result verification

The client submits its **event log** (which targets it hit, and when) — never a score it wants
trusted. `src/lib/game/verify.ts` replays that log through the same deterministic engine the
client used and rejects impossible input:

- unknown / duplicate / already-expired targets,
- hits faster than a human reaction time (70 ms after spawn),
- events after the match clock ended,
- scores above the theoretical ceiling for that schedule,
- a `clientScore` that disagrees with the replay.

Only a verified result can be settled.

---

## Audio & soundtrack

All audio is synthesised in the browser with the Web Audio API — there are no media files
to download and nothing to preload, so audio never competes with the game for load time.

- **Original soundtrack.** An 8-bar, 124 BPM electro/arcade loop authored for Chain Duel in
  [`src/lib/sound/music.ts`](src/lib/sound/music.ts). It is generated from the project's own
  source rather than sampled, so it is legally safe for commercial use with no third-party
  attribution. See [docs/audio.md](docs/audio.md).
- **Seamless and cheap.** A look-ahead scheduler queues notes ~200 ms ahead of the audio
  clock, so the loop point is sample-accurate. Notes are short, self-stopping nodes, so CPU
  stays flat and nothing accumulates. The sequencer pauses when the tab is hidden.
- **Autoplay-aware.** On load the engine starts immediately when the browser already permits
  it; otherwise it starts on the first tap/click/key press. Entering a duel asks for the
  soundtrack explicitly, and the `AudioContext` is never created on a cold load (which the
  autoplay policy would block).
- **One instance.** A module singleton owns the `AudioContext` and the music bed, so
  navigating or re-rendering can never stack soundtracks.
- **One control, one preference.** The header's speaker icon is the master sound switch and
  is mirrored in Settings. Muting stops the soundtrack and every non-gameplay cue, but the
  ball-hit click stays audible during a live duel — it is core feedback, not ambience. The
  choice is stored under `cd.sound`; the soundtrack alone can be switched off with
  `cd.music`. New players default to sound on.

---

## Architecture

```
FRONTEND (Next.js App Router, React 19, Tailwind, Framer Motion)
    ↓
GAME ENGINE (deterministic schedule + session, src/lib/game)
    ↓
REALTIME / MATCHMAKING (queue, invites, challenges)
    ↓
BACKEND / API (src/app/api/**  →  src/lib/services/**)
    ↓
VERIFICATION (src/lib/game/verify.ts — replays the event log)
    ↓
SOROBAN CONTRACT (contracts/chain_duel — escrow, fees, treasury)
    ↓
STELLAR TESTNET

BOT ENGINE (src/lib/game/bot.ts) → BOT MATCH STATE → VERIFICATION → BOT TREASURY SETTLEMENT
```

Every layer is a separate module with a narrow public surface. The frontend can *request*
actions; only the backend and the contract can *authorize* them.

See [docs/architecture.md](docs/architecture.md) for the module map and request flows.

---

## Stellar integration

All network configuration lives in one place: [`src/lib/config/stellar.ts`](src/lib/config/stellar.ts).
Nothing is hardcoded in components, and every value can be overridden by env vars
(`STELLAR_NETWORK`, `STELLAR_RPC_URL`, `STELLAR_HORIZON_URL`, `STELLAR_NETWORK_PASSPHRASE`,
`CHAIN_DUEL_CONTRACT_ID`, `CHAIN_DUEL_TOKEN_ID`).

- SDKs: `@stellar/stellar-sdk` 17, `@stellar/freighter-api` 6, `@creit.tech/stellar-wallets-kit` 2.7.
- Wallets: Freighter, xBull, Albedo, Lobstr and Rabet through Stellar Wallets Kit.
- No mocked chain calls anywhere. If the contract is not configured, escrow-dependent features
  turn **off** with an explicit error instead of pretending to work.

### Escrow lifecycle

```
CREATE ──▶ WAITING ──▶ JOINED ──▶ ACTIVE ──▶ FINISHED ──▶ SETTLED
              │                      │
              └──▶ CANCELLED ──▶ REFUNDED
                                     └──▶ EXPIRED ──▶ REFUNDED
```

The contract holds both entries until `settle_game` pays the winner (90%) and accrues the fee
(10%) atomically. If nobody joins, the creator can cancel and is refunded; after the join window
passes anyone may trigger `claim_refund`, and refunds only ever go back to the wallets that paid in.

### Transaction UX

Wallet transactions move through `preparing → waiting for wallet → signing → submitting →
confirming → confirmed` (`src/components/escrow-status.tsx`). A transaction is never shown as
confirmed before Stellar confirms it, and confirmed rows link to the real Testnet explorer page
built from the transaction hash.

See [docs/stellar.md](docs/stellar.md).

---

## Soroban escrow contract

`contracts/chain_duel` — Rust / Soroban SDK 25, no-std, with `overflow-checks` enabled in release.

Constructor:

```rust
__constructor(admin, treasury, token, fee_bps, max_entry, max_payout, min_treasury_balance)
```

Methods: `get_config`, `get_stats`, `get_game`, `get_bot_liquidity`, `get_accrued_fees`,
`get_locked_escrow`, `get_contract_balance`, `available_bot_liquidity`, `is_admin`, `create_game`,
`join_game`, `start_game`, `settle_game`, `cancel_game`, `claim_refund`, `fund_bot_pool`,
`withdraw_treasury`, `withdraw_bot_liquidity`, `set_fee_bps`, `set_paused`, `set_bot_enabled`,
`set_treasury`, `set_limits`.

Design notes:

- **Mode and status are plain `u32` on the wire** (`MODE_PVP=0`, `MODE_BOT=1`;
  status `0..6`), so the ABI is portable to any client without enum-encoding ambiguity.
- `require_admin(caller)` gates every privileged operation: settlement, pause, fee changes,
  treasury withdrawal and limit changes.
- **Withdrawals can only go to the configured treasury/admin address.** No arbitrary destination
  can be supplied, so a compromised admin UI cannot redirect funds.
- Escrow, bot liquidity and accrued fees are tracked as separate counters, and
  `get_contract_balance` is asserted against them in tests.
- `Paused` blocks new games and settlement-sensitive operations but never traps funds from
  already-valid games — refunds stay available.

See [docs/stellar.md](docs/stellar.md) for the full ABI and invariants.

---

## Authentication & wallets

| Method | How it works |
| --- | --- |
| **Freighter / xBull / Albedo / Lobstr / Rabet** | Sign-In With Stellar: the server issues a one-time challenge, the wallet signs it, the server verifies the ed25519 signature and the challenge's domain, then issues a session. |
| **Google** | Real OAuth 2.0 + PKCE (S256) with `id_token` verification through the provider JWKS. |
| **X** | Real OAuth 2.0 + PKCE (S256) against the X API v2. |
| **Demo** | A sandbox identity for judges: real account and real wallet address, no funding required. Clearly labelled in the UI. |

Social sign-in provisions a **managed (embedded) Stellar wallet**. The secret is generated on the
server and stored only as AES-256-GCM ciphertext in `wallet_keys`; the server signs escrow
transactions for that wallet. Secrets are never generated in the browser, never stored in
`localStorage`, never returned by an API and never logged.

Sessions are stateless JWTs in an `httpOnly`, `sameSite=lax` cookie, so a refresh never loses your
profile.

See [docs/security.md](docs/security.md).

---

## Matchmaking, invites and challenges

- **Play Online** — a queue keyed on game type, entry amount and availability. The queue is
  race-safe (two players matching at once cannot double-charge), and a queue ticket cannot charge
  a player more than once.
- **Challenge a player** — from the player directory, creates a direct invitation the rival sees
  in their dashboard with **Accept** / **Decline**.
- **Private duel with a friend** — creates a duel with a 6-character, cryptographically random
  code (`/duel/AB72K`) and copy/share buttons (native `navigator.share` where available).
- Invitations expire after 30 minutes; duel join windows close after 15 minutes. States:
  `created → pending → accepted / declined / expired / cancelled / completed`.
- Join validation is server-side and repeated on-chain: game id, status, player identity, entry
  amount, participant count, expiry and settlement state. A third player, a duplicate join, a
  duplicate payment or a join after completion are all rejected.

---

## Computer opponent (bot mode)

**VEX-7** is a genuine opponent, not a result screen. It runs the same `PulseDuelSession` engine as
a human with its own skill profile (reaction time and jitter, per-target accuracy, extra focus on
gold targets, combo protection, red avoidance) and its final score is produced by playing the same
deterministic schedule. Nothing about its score or the recorded result is ever rewritten.

- Its score is a pure function of `(seed, profile)`, so the score the HUD shows during the duel is
  byte-for-byte the score settlement records — the same play is simply replayed.
- The profile is calibrated so an *average* human (the reference model in `tests/bot.test.ts`) loses
  about **80%** of matches, while a strong player wins more often than not. That is a measured
  property of the skill parameters, not a coin flip on the winner.
- Never uses `Math.random()`: gameplay randomness is the seeded, replayable `Rng`.
- Bot matches are played and settled for real against the **bot treasury**, funded on-chain with
  real Testnet XLM via `fund_bot_pool`.
- If the treasury is short, bot mode disables itself and shows *"Computer matches are temporarily
  unavailable."* instead of creating a game it cannot settle.
- Bot results never affect competitive **Duel Rating**; they are tracked separately
  (`bot_games`, `bot_wins`, `bot_losses`) so rating cannot be farmed.

---

## Protocol treasury & admin

`/admin/treasury` is protected twice: the route returns 404 unless the signed-in wallet is the
configured admin, and every action calls `requireAdmin` on the server and `require_admin` in the
contract. Hidden UI is never the security boundary.

The panel shows the live on-chain treasury balance, available bot liquidity, accrued fees, locked
escrow, bot games, bot wins, player wins, treasury gains/losses, recent settlements and treasury
transactions — and a withdrawal control.

Safety rails (`src/lib/config/game.ts` + `set_limits`):

| Limit | Default |
| --- | --- |
| `MIN_TREASURY_BALANCE` | 100 XLM |
| `MAX_BOT_ENTRY` | 25 XLM |
| `MAX_PAYOUT` | 250 XLM |
| `DAILY_BOT_LIABILITY` | 1000 XLM |

The treasury can never go negative: the contract checks available liquidity before a bot game and
rejects the test suite's unauthorized withdrawals (`to=admin` only).

See [docs/admin.md](docs/admin.md).

---

## Database

One portable schema (`src/lib/db/migrations.ts`) runs on both **PostgreSQL** (production —
Supabase/Neon/any Postgres) and **SQLite** (local development, `node:sqlite`), behind a single
`SqlDriver` interface with real transactions on both.

Tables: `users`, `profiles`, `wallets`, `wallet_keys`, `games`, `game_players`, `game_events`,
`matches`, `invites`, `matchmaking_queue`, `transactions`, `ratings`, `reputation`,
`achievements`, `bot_matches`, `treasury_transactions`, `admin_actions`, `settings`,
`stellar_nonces`.

Migrations are idempotent and run automatically on first connection. No secrets are stored in any
table — managed wallet secrets live only as AES-256-GCM ciphertext in `wallet_keys`.

See [docs/database.md](docs/database.md).

---

## Local setup

Requirements: Node 22+, Rust with the pinned toolchain, and the Stellar CLI.

```bash
npm install

# 1. (optional) contract toolchain
rustup toolchain install 1.92.0 --target wasm32v1-none
# Stellar CLI: https://developers.stellar.org/docs/tools/developer-tools/cli/install-cli

# 2. copy env and fill in what you need
cp .env.example .env.local

# 3. run
npm run dev          # http://localhost:4310
```

Without a contract configured the app still runs: demo duels work fully off-chain and
escrow-dependent modes turn off with a clear message. To enable real escrow locally, run the
Testnet bootstrap below.

Useful scripts:

| Script | Purpose |
| --- | --- |
| `npm run dev` | Dev server on port 4310 |
| `npm run build` / `npm start` | Production build and server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (Next config) |
| `npm test` | Vitest unit/integration suite |
| `npm run test:contract` | Rust contract tests |
| `npm run verify` | typecheck + lint + tests + production build |
| `npm run verify:all` | the above plus contract tests |
| `npm run stellar:verify` | Read the deployed contract back from Testnet |
| `npm run treasury:fund -- 500` | Fund bot liquidity with 500 XLM |
| `npm run db:seed` | Seed demo players and match history |

---

## Testnet setup

One command creates (or reuses) the admin key, funds it with Friendbot, builds and deploys the
contract, and writes `.env.local`:

```bash
npm run stellar:setup
npm run treasury:fund -- 500     # give the bot treasury real liquidity
npm run stellar:verify           # read the config/stats back from the chain
```

To redeploy with an existing key:

```bash
CHAIN_DUEL_ADMIN_SECRET=S... node scripts/deploy-contract.mjs --write-env
```

`.env.local` is gitignored and written with mode `0600`. **The admin secret key must never be
committed, exposed to the browser, or stored in the database.**

---

## Deployment

The app is Vercel-ready (`next build`, App Router, `pg` for Postgres).

Production: **https://chain-duel.vercel.app** (Stellar Testnet, Neon Postgres, Google + X
sign-in live). The production database is a pooled Postgres connection; the app fails closed
with a 503 rather than falling back to in-memory state when it is unreachable.

1. Import the repository in Vercel, or run `vercel deploy --prod`.
2. Set the environment variables from [`.env.example`](.env.example). At minimum for a durable
   production deployment:
   - `DATABASE_URL` — a Postgres connection string (Supabase, Neon, …). **Required in
     production**: use the provider's *pooled* connection string for serverless. Without it the
     app refuses to serve authenticated state (HTTP 503) instead of pretending data persisted.
   - `SESSION_SECRET`, `WALLET_ENCRYPTION_KEY` — 32+ random characters each (the app refuses to
     start in production with insecure defaults).
   - `SETTLEMENT_SECRET_KEY`, `ADMIN_WALLET_ADDRESS`, `CHAIN_DUEL_CONTRACT_ID`,
     `CHAIN_DUEL_TOKEN_ID`, `STELLAR_NETWORK`.
   - `APP_URL` — the public URL, so OAuth redirects and SIWS domains match.
3. Migrations run automatically on the first request.
4. Google/X sign-in additionally need `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` and
   `X_CLIENT_ID`/`X_CLIENT_SECRET`, with
   `https://<your-domain>/api/auth/oauth/<provider>/callback` registered as a redirect URI.
5. Set `CRON_SECRET` so the daily Vercel Cron (`vercel.json` → `/api/cron/maintenance`) can
   authenticate. It refunds expired private duels, expires stale queue entries and settles
   abandoned matches. Without it the sweep can still be run manually with
   `?token=$SESSION_SECRET`; a read-time sweep also runs on the relevant write paths.

---

## Testing

```bash
npm run verify        # typecheck + lint + 113 unit/integration tests + production build
npm run test:contract # 21 Rust contract tests

# opt-in live suites: spend real Testnet XLM against the deployed contract
CHAIN_DUEL_LIVE=1 npx vitest run tests/live-e2e.test.ts
CHAIN_DUEL_LIVE=1 npx vitest run tests/live-flows.test.ts
CHAIN_DUEL_LIVE=1 npx vitest run tests/live-treasury.test.ts

# smoke the deployed app (demo duel, no funds)
CHAIN_DUEL_LIVE=1 CHAIN_DUEL_DEPLOYED_URL=https://chain-duel.vercel.app \
  npx vitest run tests/live-deployed.test.ts
CHAIN_DUEL_LIVE=1 CHAIN_DUEL_DEPLOYED_URL=https://chain-duel.vercel.app \
  npx vitest run tests/live-rematch.test.ts
```

What is covered:

- **Game engine** — deterministic schedules, scoring, combos, penalties, and every verifier
  rejection case (forged, too-fast, expired, impossible scores).
- **Bot** — plays the real engine, statistical ~80% configured win rate over 4000 simulated
  matches, bounded ceiling, no `Math.random()`, resumable state.
- **Duel lifecycle** — creation, self-join and full-duel rejection, verified submission,
  idempotent settlement, bot settlement, and honest refusal when the contract is absent.
- **Rating & reputation** — Elo zero-sum with a floor; bot games excluded from rating; payouts
  match `5 + 5 → 9 + 1`.
- **Security** — SIWS sign/verify/replay/domain/tamper, AES-256-GCM sealing, username rules,
  non-sequential invite codes, admin denial.
- **Contract** — create/join/cancel/refund/start/settle, fee math, winner payout, bot settlement,
  treasury accounting, admin and unauthorized withdrawal, duplicate settlement, invalid/expired
  game, wrong player, wrong amount, and the balance invariant across a full bot match.
- **Live (opt-in)** — a real 1v1 duel (5 + 5 XLM escrowed, settled, winner paid, hash in
  history); random matchmaking pairing two queued accounts into one duel; a targeted challenge
  through the invite inbox (including a premature accept that is refused cleanly and an
  unauthorised accept that is rejected); a creator cancel with an on-chain refund; and a bot
  duel whose database treasury accounting reconciles exactly with the on-chain bot liquidity,
  accrued fees and treasury wallet movement.
- **Treasury (opt-in)** — anonymous, player, destination-injected and correctly-signed
  non-admin withdrawal attempts all fail; only the designated developer wallet may withdraw, and
  the withdrawal is recorded in the admin audit log.
- **Play again (opt-in, deployed)** — after a matchmaking duel settles its ticket is released, so
  the next search starts a new duel instead of looping back to the finished result screen.

---

## Security

The single most important rule: **never trust the frontend.**

- The backend verifies every action; the contract independently enforces authorization, amounts,
  state transitions and payout destinations.
- Game results are replayed from an event log — a client cannot submit an arbitrary score.
- Settlement is idempotent: a `settlement_status` compare-and-set guarantees exactly one payout,
  the settlement hash is persisted before local bookkeeping, and the bookkeeping runs in a
  database transaction so a retry can never double-pay or double-count.
- Managed wallet secrets are encrypted at rest (AES-256-GCM) and only ever decrypted inside the
  server-side signing service.
- Treasury withdrawal is admin-only, destination-locked, and audited.
- Sessions are httpOnly JWTs; OAuth uses PKCE with state validation.

Full threat model and mitigations: [docs/security.md](docs/security.md).

---

## Known limitations

- The bot treasury is replenished by the protocol, not automatically: each computer match commits
  one entry of liquidity from the pool, so the pool needs occasional `treasury:fund` top-ups. This
  is by design and is visible on-chain and in `/admin/treasury`.
- Matchmaking is intentionally simple (game type + entry + availability). Ranked matchmaking and
  tournaments are future work.
- The live contract instance was deployed before `admin`/`treasury` were split into separate
  roles; see the contract revision note above. Both roles are the same Testnet wallet today.

