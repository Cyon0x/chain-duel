# Database

One portable schema, defined in [`src/lib/db/migrations.ts`](../src/lib/db/migrations.ts), runs on
both backends behind the `SqlDriver` interface
([`src/lib/db/drivers.ts`](../src/lib/db/drivers.ts)):

| Environment | Driver | Mode reported by `/api/health` |
| --- | --- | --- |
| `DATABASE_URL` set | PostgreSQL (`pg`, pool of 8) | `postgres` |
| dev, no `DATABASE_URL` | SQLite `node:sqlite`, file | `sqlite-file` |
| prod, no `DATABASE_URL` | SQLite `node:sqlite`, in-memory | `sqlite-memory` |

Both drivers expose `query`, `one`, `execute`, `run` and **real `transaction`** support, so
settlement bookkeeping is atomic on either backend. `?` placeholders are translated to `$n` for
Postgres. Migrations are idempotent and applied on first connection, so a deploy self-provisions.

## Tables

### Identity

| Table | Purpose |
| --- | --- |
| `users` | Account: `auth_provider` (`stellar`/`google`/`x`/`demo`), `provider_account_id`, `primary_wallet`, `is_admin`. Unique on (provider, provider_account_id) and on `primary_wallet`. |
| `profiles` | Public identity and statistics: `username`/`username_lower` (unique), `avatar`, `theme`, `rating`, `reputation`, `wins`, `losses`, `games_played`, `human_games`, `bot_games`, `bot_wins`, `bot_losses`, `current_streak`, `best_streak`, `total_earned_stroops`, `total_wagered_stroops`, `fees_paid_stroops`, `achievements`, `onboarding_complete`. |
| `wallets` | Linked wallets: `address` (unique), `provider`, `custody` (`external`/`managed`), `is_primary`, `network`. |
| `wallet_keys` | **Managed wallet secrets only**: AES-256-GCM `ciphertext`, `iv`, `auth_tag`, `algo`. Separate table so key material can never leak through an ordinary wallet query. |
| `sessions` | Session audit rows. |
| `stellar_nonces` | One-time SIWS challenges with expiry and `consumed_at` (replay defence). |

### Duel

| Table | Purpose |
| --- | --- |
| `games` | The duel. `code` (unique), `mode`, `status`, `visibility`, players, `entry_stroops`, `pool_stroops`, `fee_bps`, `payout_stroops`, scores, `seed`, `duration_ms`, `escrow_state`, `settlement_status`, `contract_game_id`, `result_hash`, `create_tx_hash`, `join_tx_hash`, `settle_tx_hash`, `demo`, `bot_outcome`, `bot_state`, timestamps (created/expires/started/finished/settled). |
| `game_players` | One row per seat: `seat`, `address`, `score`, `max_combo`, `hits`, `misses`, `is_bot`, `result`. |
| `game_events` | Append-only match log: `match_started`, `invite_declined`, `submission_rejected`, progress pings, etc. Also the source of the HUD's *provisional* live opponent score — never used for settlement. |
| `invites` | `code`, `game_id`, `creator_id`, `invited_user_id`, `channel`, `entry_stroops`, `status`, `expires_at`, `accepted_by`. |
| `matchmaking_queue` | Queue tickets: `status` (`searching`/`matched`/`cancelled`/`expired`/`completed`), `game_type`, `entry_stroops`, `demo`, `game_id`, `expires_at`. |
| `matches` | Per-player, per-game result used by history, leaderboard and profiles. Unique on (game_id, user_id), which also makes settlement bookkeeping retry-safe. |
| `ratings` | Rating audit: `rating_before`, `rating_after`, `delta`, `mode`. |
| `reputation` | Reputation audit: `delta`, `reason`. |
| `achievements` | `code`, `progress`, `unlocked_at`. Unique on (user_id, code). |
| `bot_matches` | Full computer-match accounting: player, bot, entry, bot stake, both scores, winner, fee, player reward, treasury delta, settlement hash. |

### Money

| Table | Purpose |
| --- | --- |
| `transactions` | Player ledger: `kind` (`entry`/`payout`/`fee`/`refund`/`bot_settlement`/…), `direction`, `amount_stroops`, `status` (`preparing` → `awaiting_wallet` → `signing` → `submitting` → `confirming` → `confirmed`/`failed`), `tx_hash`, `ledger`, `address`, `error`, `explorer_url`, `metadata`, `demo`, timestamps. A hash is indexed, **not unique**: one Stellar transaction can back several ledger lines. |
| `treasury_transactions` | Protocol treasury movements: `kind` (`bot_settlement`, `fee_accrual`, `bot_funding`, withdrawals), `direction`, amount, `balance_after_stroops`, `tx_hash`, `game_id`, `actor`. |
| `admin_actions` | Audit log: `admin_wallet`, `action`, `target`, `payload`, `tx_hash`, `created_at`. |
| `settings` | Server-side gameplay configuration with `updated_at`/`updated_by`. |

## Conventions

- Text ids with prefixes (`txn_`, `gam_`, `mat_`, `trs_`, `adm_`), ISO-8601 text timestamps,
  integer stroops (1 XLM = 10,000,000 stroops) so no floating point ever touches money.
- JSON payloads are stored as text and parsed through `parseJson`.
- No secret is stored anywhere except the encrypted blob in `wallet_keys`.

## Local inspection

```bash
node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('./chain-duel.db');\
console.log(d.prepare(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\").all())"
```

## Migrating to Postgres

Set `DATABASE_URL` (e.g. a Supabase pooled connection string with `?sslmode=require`) and restart.
The same schema is created automatically. Note that `sqlite-memory` is **not** durable across
serverless invocations — production requires `DATABASE_URL`.

