# Administration

The protocol's money and configuration are controlled by a single designated developer/admin
wallet. There is no moderator tier and no way for a player to reach these operations.

## Authorization layers

Admin authority is enforced at three independent layers — a hidden button is never one of them:

1. **UI** — `/admin/treasury` returns a 404 unless the signed-in wallet is the admin (so the page
   does not even advertise its existence).
2. **API** — every action calls `requireAdmin(userId)` in
   [`src/lib/services/admin.ts`](../src/lib/services/admin.ts), which resolves the caller's wallet
   and compares it to the configured admin address.
3. **Contract** — `require_admin(caller)` inside the Soroban contract, which also binds the
   withdrawal destination to `config.treasury`. Even a fully compromised API cannot send funds
   anywhere but the treasury.

The admin wallet is resolved from `ADMIN_WALLET_ADDRESS`, falling back to the contract's
`get_config().admin`. The dashboard surfaces `settlementKeyMatchesAdmin` so a misconfigured
deployment is obvious.

## Setting the admin

The admin is set at contract deploy time and is the account that deployed it:

```bash
npm run stellar:setup    # generates/funds the key and writes ADMIN_WALLET_ADDRESS + SETTLEMENT_SECRET_KEY
```

`SETTLEMENT_SECRET_KEY` must belong to `ADMIN_WALLET_ADDRESS` for settlement and withdrawal to work
(the contract checks `require_auth` on the admin address).

## `/admin/treasury`

The panel shows, live from the chain and the database:

- treasury balance, available bot liquidity, accrued fees, locked escrow,
- bot games, bot wins, player wins, treasury gains and losses,
- recent bot matches (entry, both scores, winner, fee, reward, treasury delta, settlement hash),
- recent treasury transactions and the admin audit log,
- the configured limits,
- a withdrawal control (accrued protocol revenue only).

## Withdrawal rules

- Only the admin wallet may withdraw; tested denials cover player A, player B, a random wallet, an
  unauthenticated request and an invalid signature.
- The destination is **always** the treasury/admin wallet. There is no destination input.
- A withdrawal cannot exceed accrued protocol revenue (`accrued_fees`), and the contract refuses to
  drop the treasury below `MIN_TREASURY_BALANCE`.
- Every withdrawal is written to `admin_actions` with the admin wallet, amount, timestamp and
  transaction hash, and returns an explorer link.

## Configuration

Server-side gameplay configuration (safe to change without redeploying the contract) lives in
[`src/lib/config/game.ts`](../src/lib/config/game.ts) and the `settings` table:

- game duration, target scores, combo multipliers, spawn cadence,
- entry bounds, protocol fee (mirrors the contract's `fee_bps`),
- bot parameters (reaction time, accuracy, jitter, mistake rate, combo awareness) and the
  server-only win probability,
- treasury thresholds: `MIN_TREASURY_BALANCE`, `MAX_BOT_ENTRY`, `MAX_PAYOUT`,
  `DAILY_BOT_LIABILITY`.

Security-critical values are duplicated on-chain and enforced there: `fee_bps`, `max_entry`,
`max_payout`, `min_treasury_balance`, `paused`, `bot_enabled`, `treasury`. Change them through the
admin contract methods (`set_fee_bps`, `set_limits`, `set_paused`, `set_bot_enabled`,
`set_treasury`, `set_admin`), which require the admin's signature. Treasury withdrawals are
deliberately *not* an admin operation: they require the designated developer wallet's signature.

## Emergency pause

`set_paused(true)` blocks new games and settlement-sensitive operations. It deliberately does not
trap funds: refunds and cancellations for already-valid games remain available, so a pause can
never lock a player's entry permanently.

## Treasury model (bot liquidity)

- `fund_bot_pool(from, amount)` moves real XLM into the pool (the admin runs
  `npm run treasury:fund -- 500`).
- A computer match commits one entry of liquidity from the pool at creation. When the human wins,
  the pool funds the payout; when the computer wins, the player's entry becomes protocol revenue
  while the committed liquidity stays with the protocol.
- `available_bot_liquidity` (balance above `MIN_TREASURY_BALANCE`) is checked before every bot
  match, and `InsufficientBotLiquidity` protects the pool on-chain, so the treasury can never go
  negative and bot mode simply disables itself when it is short.
- Practically, the pool needs occasional top-ups from the protocol; this is visible in
  `/admin/treasury` and auditable on-chain.

## Audit log

`admin_actions` records treasury withdrawals and deposits, bot configuration changes, fee changes,
pause/unpause and other admin actions, each with the admin wallet, action, timestamp and (where
applicable) the Stellar transaction id.

