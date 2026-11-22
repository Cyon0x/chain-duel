# Chain Duel multi-chain release status

Release date: 2026-11-22. Arc Mainnet wallet signing, staking, computer-game
settlement and cancellation/refund passed live owner validation. This release
activates Arc gaming in the existing production project. CCTP remains disabled;
the overall multi-chain expansion is not marked complete.

## Released behavior

A settled Arc duel shows **You won** to its human winner and **You lost** to the
losing participant, including a loss to the computer. Each player row shows
**Won** or **Lost** with the score. Spectators see a neutral result. Pending
settlement does not show a final outcome. The result comes from the confirmed
server winner, independently of the displayed scores.

Arc gas and ERC-20 stakes spend the same USDC balance. Before creating a Circle
signing challenge, the server obtains the official fee quote and requires the
stake or burn amount plus the full maximum gas reserve. The challenge uses those
exact absolute fee parameters. An underfunded request fails before PIN signing
with the required USDC amount; its lease is released for a funded retry.
Approvals, cancellations, refunds and destination mints reserve gas without
requiring their incoming amount as a debit. The original Stellar paths are unchanged.

## Preserved Stellar behavior

Baseline: `898340b24c45211690725158fa3bfab207ef4bd2`. All 117 protected Stellar files
match it. Existing contracts, addresses, authentication clients, managed wallets,
records, queues, environment settings and 90/10 economics remain intact.
Production Stellar gaming remains **Testnet**. It was not moved to Mainnet.
Arc routes, tables, OAuth clients, Circle wallets and 90/5/5 escrow are independent.
Original startup migrations remain compatible with the additive PostgreSQL tables.

## Arc contract and verified financial flows

- Chain ID: 5042; RPC: https://rpc.mainnet.arc.io.
- Escrow: `0xc68d4a23433a51d17cf3358ee1281a13b6e58210`.
- USDC: `0x3600000000000000000000000000000000000000`, six ERC-20 decimals;
  native USDC gas uses 18 decimals and shares its underlying balance.
- Minimum/maximum stake: **0.50 / 1,000 USDC**, enforced in the frontend,
  backend and immutable contract parameters.
- Owner, authority, both fee recipients and bot treasury:
  `0x73cc6bd174543be6f2fb40da7c3c041ceb8c0b1d`.
- Deployment transaction:
  `0xf85a02f227beed53a6cef671ba1a78f6624a95c46fe3c9ef56922ccea5a16c18`.
- [Exact creation/runtime verification](https://sourcify.dev/#/lookup/5042/0xc68d4a23433a51d17cf3358ee1281a13b6e58210).

The owner completed a 0.50 USDC computer stake and a full game. Settlement
`0x1135c9467db699218ec79767fa88c5d060210ce467edaa1fd796ed00f355d65f`
confirmed a 1.00 USDC pool: 0.90 winner share and two 0.05 fee shares. The
computer won, so its 0.90 share remained in the bot reserve. Both actual fee
transfers were verified. The reserve is now 5.40 USDC, locked player escrow is
zero, and the contract balance reconciles with their sum.

A separate owner stake was cancelled. Transaction
`0x14344d3cc69c24e54213ca8a4309f2564e14f0284277e76cd40b31055e515404`
returned the full 0.50 USDC stake to its original wallet. Receipt, event, sender,
calldata, history and repeated-refresh idempotency were verified. Human-winning
and PvP payout paths passed contract tests; this report does not claim a live
human-winning payout. Evidence: `arc-deployments/owner-flow-mainnet.json`.

The earlier deposit reverted because its pre-execution gas reserve left less
than the stake available to transfer. Historical simulation with the reserved
balance reproduced `ERC20: transfer amount exceeds balance`. The new preflight
blocks that condition. Circle accepted the absolute-fee authorization challenge,
and repeated requests returned the same challenge. This provider configuration
check did not execute another financial transaction.

## Wallets, authentication and bridge status

Dedicated Arc Google/X OAuth 2.0 clients use isolated PKCE callbacks. Google
validates issuer, audience and nonce; X verifies user-context identity. The
existing Stellar clients are preserved. Circle User-Controlled Wallets use
idempotent verified user associations and PIN signing; no user private key or PIN
is stored by the application. Live Google registration, wallet creation, PIN
setup and transaction signing passed. Live X registration and PIN recovery remain
owner interaction checks. Supplied secrets remain outside Git and frontend bundles.

Official CCTP V2 supports Arc domain 26 and Stellar domain 27 in both directions.
The implementation validates official infrastructure, amounts, fees, attestations,
nonce/message identity and actual destination settlement. Both routes remain
inactive. The owner's existing Stellar address has no Mainnet account or USDC
trustline; Mainnet XLM activation/reserve funding and owner-approved transfers
are needed before both directions can be verified. Stellar Testnet gameplay is
not evidence of Stellar Mainnet bridge readiness.

## Verification

- TypeScript, ESLint and optimized application/Preview builds passed.
- 264 application tests passed; 16 opt-in tests skipped in the default suite.
- 16 Solidity tests passed, including 256 conservation fuzz runs, shared roles,
  stake limits, player/bot wins, PvP, replay, refunds and unauthorized settlement.
- 23 original Soroban tests passed; 117 protected Stellar files unchanged.
- Real PostgreSQL migration/preservation regression passed in its isolated schema.
- Preview passed 12 pages and ten backend/OAuth/network/render checks.
- Browser result fixtures covered human wins, computer/PvP losses, pending
  settlement and spectators at 390, 768 and 1440 pixels, with no overflow or errors.
- Live owner Circle signing, stake, bot settlement, two fee transfers, refund,
  escrow reconciliation and history idempotency passed.

The recorded engineering review is not an independent third-party certification.
The previous dependency review retains 28 production advisories, including ten
high advisories in the preserved Stellar wallet dependency tree and zero critical.
This release makes no clean-audit claim.

## GitHub and Vercel

Repository: https://github.com/Cyon0x/chain-duel. Production branch: `main`.
Existing Vercel project: `chain-duel`.
Production domains: https://www.chainduel.site and https://chain-duel.vercel.app.
Verified release Preview: https://chain-duel-bc32fzyzf-cyon0xs-projects.vercel.app,
`dpl_Cu7xMdEcsqot6kQ8J4ZSKBe65qjW`.
Stable owner Preview: https://chain-duel-multichain-preview.vercel.app.
Preview uses the separate `chain_duel_multichain_preview` database.

The approved rollout sets production `ARC_GAMING_ENABLED=true`. Wallets and the
reviewed Mainnet escrow remain configured. All CCTP activation flags stay false.
Production readiness, public configuration, deployed pages and the existing
Stellar game regression are checked after integration.
