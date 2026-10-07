# Architecture

Chain Duel is deliberately layered so that gameplay speed and financial safety never fight each
other. Each layer has one job, and the layers below it assume the layers above are hostile.

```
┌────────────────────────────────────────────────────────────────────────┐
│ FRONTEND            src/app/**, src/components/**                      │
│  App Router pages, arena, HUD, motion, themes, custom cursor, audio     │
└──────────────────────────────┬─────────────────────────────────────────┘
                               │ fetch (JSON)
┌──────────────────────────────▼─────────────────────────────────────────┐
│ GAME ENGINE         src/lib/game/**                                    │
│  pulse.ts  deterministic schedule + incremental session (same on both  │
│  rng.ts    crypto-backed RNG + seeded shuffle                          │
│  verify.ts authoritative replay of a submitted event log                │
│  bot.ts    VEX-7 opponent: deterministic skill model (≈80% vs average) │
│  outcome.ts authoritative WIN/LOSE/DRAW from settled game state        │
└──────────────────────────────┬─────────────────────────────────────────┘
                               │
┌──────────────────────────────▼─────────────────────────────────────────┐
│ REALTIME / MATCHMAKING      src/lib/services/matchmaking.ts            │
│  queue tickets, direct challenges, private invite codes, TTLs           │
└──────────────────────────────┬─────────────────────────────────────────┘
                               │
┌──────────────────────────────▼─────────────────────────────────────────┐
│ BACKEND / API       src/app/api/**  →  src/lib/services/**             │
│  auth, profile, duel, match, treasury, admin, players, leaderboard,     │
│  transactions. Every route validates input and re-checks authorization. │
└──────────────────────────────┬─────────────────────────────────────────┘
                               │
┌──────────────────────────────▼─────────────────────────────────────────┐
│ VERIFICATION                src/lib/game/verify.ts                     │
│  Replays the event log against the stored seed. A submitted score is    │
│  never trusted; an impossible log is rejected with a 422.               │
└──────────────────────────────┬─────────────────────────────────────────┘
                               │
┌──────────────────────────────▼─────────────────────────────────────────┐
│ SOROBAN CONTRACT    contracts/chain_duel/src/lib.rs                    │
│  Escrow, settlement, fee accrual, bot liquidity, treasury, admin gates  │
└──────────────────────────────┬─────────────────────────────────────────┘
                               │
┌──────────────────────────────▼─────────────────────────────────────────┐
│ STELLAR TESTNET     RPC + Horizon                                      │
└────────────────────────────────────────────────────────────────────────┘
```

The bot path is parallel and never touches human escrow:

```
BOT ENGINE → BOT MATCH STATE → VERIFICATION → BOT TREASURY SETTLEMENT
```

## Module map

| Concern | Module |
| --- | --- |
| Network + explorer config | `src/lib/config/stellar.ts` |
| Gameplay + economy constants | `src/lib/config/game.ts` |
| Themes | `src/lib/config/themes.ts` |
| Environment access (lazy, degraded-but-honest) | `src/lib/config/env.ts` |
| SQL driver (SQLite + Postgres) | `src/lib/db/drivers.ts` |
| Schema | `src/lib/db/migrations.ts` |
| Repositories | `src/lib/db/repositories/{identity,duel,economy}.ts` |
| Soroban client | `src/lib/stellar/{server,contract,wallet}.ts` |
| Escrow + settlement orchestration | `src/lib/services/escrow.ts` |
| Duel lifecycle | `src/lib/services/duel.ts` |
| Match lifecycle + settlement | `src/lib/services/match.ts` |
| Treasury accounting | `src/lib/services/treasury.ts` |
| Admin authorization | `src/lib/services/admin.ts` |
| SIWS | `src/lib/auth/stellar.ts` |
| OAuth (PKCE) | `src/lib/auth/oauth.ts` |
| Sessions | `src/lib/auth/session.ts` |
| Wallet handshake (client) | `src/lib/wallet/escrow-client.ts` |
| Arena / HUD | `src/components/game/arena.tsx` |
| Result resolution (WIN/LOSE/DRAW) | `src/lib/game/outcome.ts` |
| Result screens | `src/components/game/result.tsx` |

## Request flows

### Creating a staked private duel (external wallet, e.g. Freighter)

1. `POST /api/duels` — server validates the entry, generates `secureSeed(16)` and a random
   `contractGameId`, inserts the game + creator seat + invite, returns `escrow.mode =
   "wallet-signature"`.
2. Client `runEscrow()` → `POST /api/duels/:id/entry {action:"commit"}` → server builds and
   simulates `create_game` and returns the unsigned XDR plus a `preparing` ledger row.
3. The player's wallet signs the XDR; the client posts `{action:"confirm", signedXdr,
   transactionId}`.
4. The server submits it to Stellar, waits for confirmation, then marks the ledger row confirmed
   and advances the game's escrow state. Nothing is considered locked before `SUCCESS`.

### Joining (managed/embedded wallet)

1. `POST /api/duels/join` validates status/expiry/seat, adds the player, and commits the entry
   on-chain with the sealed server-side key.
2. The response carries the escrow handoff; the client `completeEscrow()` finishes it (no-op when
   already confirmed) instead of committing a second time.
3. A retried `commit` for a seat that has already paid returns the original transaction instead of
   a contract error — money already moved is never reported as a failure.

### Settling

1. Each human submits an event log; the server replays it. When every human seat has a verified
   result, `settleMatch()` runs.
2. A compare-and-set claims settlement (`settlement_status: null|failed → submitting`), so exactly
   one caller proceeds.
3. `settle_game` is invoked by the settlement authority and pays the winner atomically.
4. The Stellar hash is persisted **before** local bookkeeping; then stats, ratings, reputation,
   ledger rows and the final game status are written in a single database transaction.
5. If bookkeeping fails, the game is marked `failed` and a retry resumes from the persisted hash —
   the chain is never settled twice and the player is never left with a wrong balance.

