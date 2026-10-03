# Supabase / Postgres

Chain Duel runs on any PostgreSQL connection string; Supabase is the recommended provider.
There is no separate SQL file to apply — the schema is defined once in
[`src/lib/db/migrations.ts`](../src/lib/db/migrations.ts) and applied automatically on the first
request that touches the database.

## Setup

1. Create a Supabase project.
2. Copy the **pooled** connection string (Project Settings → Database → Connection pooling) and set
   it as `DATABASE_URL`:

   ```
   DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres?sslmode=require
   ```

3. Deploy / restart. The app creates every table and index on first connection. `/api/health`
   should report `"persistence": "postgres"`.

The driver sets `ssl: { rejectUnauthorized: false }` when the URL contains `sslmode=require`, and
translates `?` placeholders to `$n` for Postgres. Transactions use a dedicated pooled client, so
settlement bookkeeping is atomic.

## Notes

- No secrets are stored in the database; managed wallet keys are AES-256-GCM ciphertext in
  `wallet_keys` and require `WALLET_ENCRYPTION_KEY` to decrypt, so a database dump alone is not
  enough to sign for a user.
- Use the pooled (pgbouncer) port for serverless deployments to avoid connection exhaustion; the
  pool is capped at 8 connections.

