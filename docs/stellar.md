# Stellar integration

## Network configuration

Everything comes from one module — [`src/lib/config/stellar.ts`](../src/lib/config/stellar.ts) —
so no component or service hardcodes an endpoint.

| Network | RPC | Passphrase |
| --- | --- | --- |
| `testnet` (default) | `https://soroban-testnet.stellar.org` | `Test SDF Network ; September 2015` |
| `futurenet` | `https://rpc-futurenet.stellar.org` | `Test SDF Future Network ; October 2022` |
| `mainnet` | `https://mainnet.sorobanrpc.com` | `Public Global Stellar Network ; September 2015` |
| `local` | `http://localhost:8000/soroban/rpc` | `Standalone Network ; February 2017` |

Overridable with `STELLAR_NETWORK`, `STELLAR_RPC_URL`, `STELLAR_HORIZON_URL`,
`STELLAR_NETWORK_PASSPHRASE`. Explorer links are derived from the network, so a Testnet
transaction always links to `stellar.expert/explorer/testnet/tx/<hash>`.

Native XLM Stellar Asset Contract (Testnet): `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`.

## SDK usage

- Writes use the documented multi-party authorization flow: build → `simulateTransaction`
  (which yields the auth entries) → `authorizeEntry` → rebuild → sign → `sendTransaction` →
  poll `getTransaction` until `SUCCESS`. See `invokeWithKeypair` in
  [`src/lib/stellar/server.ts`](../src/lib/stellar/server.ts).
- Reads use `simulateTransaction` and `scValToNative`; nothing is cached across requests.
- Client-side signing goes through Stellar Wallets Kit for Freighter, xBull, Albedo, Lobstr and
  Rabet, with a network check before signing so a wallet on the wrong network fails with a clear
  message instead of a confusing simulation error.

## Escrow lifecycle

```
create_game  ──▶ WAITING ──▶ join_game ──▶ JOINED ──▶ start_game ──▶ ACTIVE
                   │                                             │
                   │ cancel_game (creator/admin)                 │ settle_game (admin)
                   ▼                                             ▼
               CANCELLED ──▶ refund                            SETTLED

WAITING/JOINED + expiry  ──▶ claim_refund (anyone) ──▶ EXPIRED ──▶ refund
```

For a bot game, `create_game` also commits matching liquidity from the bot pool, so the escrow is
10 XLM from the moment the human pays. `join_game` is only valid for `MODE_PVP`.

Refunds always return each deposit to the wallet that made it; the contract cannot send a refund
anywhere else.

## Contract interface

Modes: `MODE_PVP = 0`, `MODE_BOT = 1`.

Statuses: `WAITING = 0`, `JOINED = 1`, `ACTIVE = 2`, `FINISHED = 3`, `SETTLED = 4`,
`CANCELLED = 5`, `EXPIRED = 6`.

Errors: `1 AlreadyInitialized`, `2 NotInitialized`, `3 Unauthorized`, `4 Paused`,
`5 GameNotFound`, `6 GameNotWaiting`, `7 GameNotJoined`, `8 GameNotActive`,
`9 GameAlreadySettled`, `10 GameExpired`, `11 GameNotExpired`, `12 DuplicatePlayer`,
`13 InvalidAmount`, `14 InvalidFee`, `15 InvalidWinner`, `16 InsufficientBotLiquidity`,
`17 InsufficientTreasury`, `18 ExceedsMaxPayout`, `19 BelowMinTreasury`, `20 NothingToWithdraw`,
`21 InvalidStatus`, `22 Overflow`.

| Function | Auth | Purpose |
| --- | --- | --- |
| `__constructor(admin, treasury, token, fee_bps, max_entry, max_payout, min_treasury_balance)` | deploy | One-time configuration |
| `create_game(creator, id, mode, entry_amount, expiry_ledger)` | creator | Locks the entry (+ bot stake for bot games) |
| `join_game(player, id)` | player | Matches the entry (PVP only) |
| `start_game(id)` | admin | Marks the duel live |
| `settle_game(id, winner, p1_score, p2_score, result_hash)` | admin | Pays winner, accrues fee |
| `cancel_game(caller, id)` | creator/admin | Refunds a duel nobody joined |
| `claim_refund(id)` | anyone | Refunds after expiry |
| `fund_bot_pool(from, amount)` | from | Adds treasury liquidity |
| `withdraw_treasury(amount)` | treasury | Sends accrued fees to the treasury wallet only |
| `withdraw_bot_liquidity(amount)` | treasury | Removes surplus bot liquidity above the minimum |
| `set_fee_bps`, `set_paused`, `set_bot_enabled`, `set_treasury`, `set_admin`, `set_limits` | admin | Configuration |

`admin` is the settlement/verifier authority (the server signing key): it settles games and changes
protocol settings. `treasury` is the designated developer wallet: it is the sole withdrawal
authority *and* the sole withdrawal destination, so the server key is structurally unable to move
treasury revenue. `set_treasury` rotates the developer wallet; `set_admin` rotates the server signer
independently.
| `get_config`, `get_stats`, `get_game`, `get_bot_liquidity`, `get_accrued_fees`, `get_locked_escrow`, `get_contract_balance`, `available_bot_liquidity`, `is_admin` | — | Reads |

### Invariants enforced on-chain

- `entry_amount > 0` and `<= max_entry`; `fee_bps <= 3000`.
- A game id can be created once.
- Joining requires `WAITING`, a different address, and an unexpired window.
- Settlement requires the winner to be one of the two players (or the treasury for a bot game),
  rejects already-settled/cancelled/expired games, and enforces `max_payout`.
- `settle_game` is atomic: payout and fee are transferred/accrued together.
- `withdraw_treasury` requires `config.treasury`'s own signature and sends only to
  `config.treasury`, only when above `min_treasury_balance`. The `admin` key cannot withdraw.
- `InsufficientBotLiquidity` blocks a bot game the pool cannot back; the pool can never go negative.

## Configuration history

| Setting | Default | Changeable |
| --- | --- | --- |
| `fee_bps` | 1000 (10%) | `set_fee_bps` (admin, ≤ 3000) |
| `max_entry` | 25 XLM | `set_limits` (admin) |
| `max_payout` | 250 XLM | `set_limits` (admin) |
| `min_treasury_balance` | 100 XLM | `set_limits` (admin) |
| `paused` | false | `set_paused` (admin) |

## Operations

```bash
npm run stellar:setup                  # deploy + write .env.local
npm run treasury:fund -- 500           # fund bot liquidity with 500 XLM
npm run stellar:verify                 # print live on-chain config/stats
npm run test:contract                  # Rust test suite (18 tests)
```

