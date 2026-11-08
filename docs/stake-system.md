# Stake system rollout

New game entries are **25–10,000 XLM per player**. The presets are 50, 100, 200,
500, 1,000, 2,000, 5,000 and 10,000 XLM. Custom entries accept up to seven decimal
places and are parsed as exact integer stroops, without rounding or JavaScript
type coercion. A 10,000 + 10,000 XLM game has a 20,000 XLM pool; at the unchanged
10% protocol fee, the winner receives 18,000 XLM and the protocol receives 2,000 XLM.

The picker, creation/challenge API, matchmaking service, signing boundary and
Soroban contract all enforce the bounds. Wallet confirmations verify the signed
invocation's contract, game, wallet, mode and exact entry before submitting it.
Computer games use the same entry ceiling but still require matching treasury
liquidity, a 100 XLM reserve and remaining daily liability allowance.

## Existing duels and deployment

The original escrow has no upgrade method. New games use the tested replacement
while previous games stay on their original escrow for joins, settlement and
refunds. Existing entries retain their original obligations. No player funds,
game history, original contract settings or secrets are migrated or overwritten.

- Original escrow (`CHAIN_DUEL_CONTRACT_ID`):
  `CBBDWEWBBQVQXNYUJ4FA6C2CXXUVDAJSNUOVPZNKTQWK5P2EON7KEGMZ`
- New escrow (`CHAIN_DUEL_STAKE_CONTRACT_ID`):
  `CD3EW4ENWDYGOGQGBJ7G2NU2YV4MLGSQW7CEIBZOYR2NQ4NJ7ZIOZ6FA`
- Verified WASM SHA-256:
  `7d2c9ea7766c58daf60f8959ebbc05b5792cb78f1ca32ddf9c9b50707d66a0c5`

The additional environment setting selects the replacement for new games.
`game_escrow_contracts` permanently binds each new game to its deployed escrow.
Unbound historical games resolve to the preserved original environment setting.
The ledger sequence is read directly from the documented `getLatestLedger` RPC
response. This avoids SDK 17.2 eagerly decoding a Testnet ledger-header extension
that it does not support; authorization and expiry still use the real network sequence.

The table is added with an idempotent migration on SQLite and Postgres. All
stroop columns already use 64-bit storage, including invites and queue entries.
Do not replace the original ID while historical duels can still need it.

Deploy another tested revision with `node scripts/deploy-stake-contract.mjs --deploy`.
It verifies Testnet and the existing admin, preserves the token/treasury/fee,
and writes a public receipt without changing environment values. Configure the
new ID only after verification. `stellar:verify` and `treasury:fund` prefer the
new setting when present.

## Swap

Swap follows Transactions in desktop and mobile navigation. It opens an
announcement modal over the current screen with the requested Coming Soon copy.
Close, Back to game, Escape and backdrop dismissal restore the previous interface
and keyboard focus. It has no swap forms, external services or transactions.

## Verification

- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.
- `npm run test:contract`: entry boundaries, all presets, custom precision,
  PvP and bot escrow/settlement, refunds, fees, permissions and balance invariants.
- `node scripts/stake-swap-qa.mjs`: seven viewport widths, menu order, modal
  controls/focus, custom validation, preset pools, exact frontend requests and
  direct API rejection. Requires an isolated local database.
- `node scripts/ui-qa.mjs`: existing onboarding, wallets chooser, navigation,
  queue, invitations, full 60-second multiplayer game, result and preferences.
- Opt-in live suites use actual Stellar Testnet funds and hashes; UI and unit
  mocks are never used as proof of successful on-chain transactions.

### Recorded Testnet verification — 8 November 2026

The live stake suite passed all five checks, including independent reads of
the settled Soroban games. Verified entries were 25 XLM, custom 125.5 XLM,
50 XLM and 10,000 XLM per player. The maximum game settled a 20,000 XLM pool,
18,000 XLM winner payout and 2,000 XLM fee:

`8ae6f5028880934f56c3e5aaf935408aa8fa38da4d132eab5372d6a2f5021b8a`

The unit suite passes 204 tests (15 live checks opt out by default); the
contract suite passes 23 tests. Existing contract event API deprecation
warnings remain. All five live regression checks passed: private PvP,
computer settlement, random matchmaking, targeted invitations and refunds.
The final build also settled a 500 XLM-per-player random match with a
1,000 XLM pool, 900 XLM payout and 100 XLM fee on the replacement escrow.
Live tests use funded disposable Testnet wallets. External
wallet extensions and physical-device rendering require manual verification.
