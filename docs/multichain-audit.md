# Multi-chain audit and implementation plan

Audit date: 2026-11-21. Baseline: `898340b24c45211690725158fa3bfab207ef4bd2`.
Branch: `feat/multichain-arc-circle`. Baseline checkout and remote main were clean and equal.

## Existing architecture

Next.js 16.3.8 App Router, React 19, TypeScript, Tailwind 4, Barlow/Chakra Petch fonts,
and Framer Motion. The off-chain Pulse Duel engine produces deterministic 60-second
target schedules; the server replays event logs before settlement. VEX-7 uses that
same engine. Online queues, private codes, and direct challenges all use the same
Stellar duel service. No score supplied by a browser authorizes payment.

PostgreSQL is production persistence, behind the same SQL interface as local
SQLite. Existing migrations run at connection time. Production refuses ephemeral
storage. Accounts, profiles, wallets, wallet_keys, games, game_players, events,
queues, invites, matches, ratings, ledger rows, and treasury audit rows are linked
by application user IDs. Historical games retain their original escrow address.

Google and X use existing OAuth authorization-code/PKCE flows. Google identity is
verified using JWKS; X identities come from its authenticated user endpoint.
Sessions use signed httpOnly cookies and server-side revocation/expiry checks.
Social login creates a managed Stellar wallet; its secret is encrypted using
AES-256-GCM in wallet_keys and only decrypted by server-side signing. External
Stellar wallets sign one-time domain-bound sign-in challenges and transaction XDR.

Escrow deposits precede gameplay. A settlement compare-and-set prevents duplicate
payments; chain hashes are saved before transactional local accounting. Winner
selection sorts verified score, combo, then seat. Existing Stellar economics are
90% winner / 10% protocol; the existing contract has one fee counter and treasury,
not two 5% recipient transfers. This MUST remain unchanged.

## Production findings

The existing `www.chainduel.site/api/health` reports Stellar **Testnet**, PostgreSQL,
Google/X enabled, escrow configured, and a settlement key configured. Calling this
existing deployment Mainnet would be inaccurate. The user's protection requirement
precludes silently changing its network or redeploying Soroban contracts.

Vercel project: `chain-duel`, ID `prj_t13Ie3yvWd3qTjpr1dbzwllWZSUo`, existing team,
Next.js preset, root `.`, Node 24.x. GitHub origin is Cyon0x/chain-duel, current
production branch main. Existing daily maintenance cron is preserved. Local and
Vercel credentials are inspected by name only; no secret values enter this report.

## Protected Stellar surface

All existing files under `contracts/chain_duel/`, `src/lib/stellar/`,
`src/lib/wallet/`, `src/lib/auth/`, `src/lib/services/`, and
`src/lib/db/repositories/` are protected, along with existing `src/lib/config/`,
`src/app/api/` routes, original migrations/drivers, and Stellar deployment scripts.
The baseline hash check will enumerate these tracked files and compare contents.
Existing frontend pages may receive a network routing boundary; their Stellar
rendering and action implementations remain intact. No original user, wallet,
ledger, game, contract address, or environment value is replaced.

## Verified external configuration

Official Arc documentation lists Mainnet chain ID **5042**, RPC
`https://rpc.mainnet.arc.io`, explorer `https://explorer.arc.io`, and Testnet
chain ID **5042002**, RPC `https://rpc.testnet.arc.io`. Native gas is USDC at
18 decimals; the ERC-20 interface `0x3600000000000000000000000000000000000000`
uses **6 decimals**. These are one balance, never two assets. Runtime differences
include the 20 Gwei max-fee floor and special USDC transfer event emitter.

Circle officially lists user-controlled EOA/SCA support for `ARC` and
`ARC-TESTNET`. Native Circle social login supports Google/Apple/Facebook, not X.
To preserve the current authentication boundary, use application-authenticated
identities plus Circle's user-controlled PIN authorization flow for both Google
and X. The server derives the Circle user ID, issues scoped tokens, and creates
challenges; the official browser SDK handles PIN, recovery answers, and consent.
The app never receives PINs, security answers, seed phrases, or Arc private keys.
Wallet provisioning is separate from login, retryable, and idempotent.

CCTP V2 officially lists Arc domain **26** and Stellar domain **27** on both
Mainnet and Testnet. Stellar requires its documented forwarder/address encoding
and seven-to-six-decimal conversion. Mainnet bridge activation additionally needs
wallet authorization, correct USDC trustlines, full two-direction test transfers,
and destination receipt verification. Official support alone is not a test result.

Sources consulted:

- https://docs.arc.io/arc/references/connect-to-arc
- https://docs.arc.io/arc/references/contract-addresses
- https://docs.arc.io/arc/references/evm-differences
- https://developers.circle.com/wallets/supported-blockchains
- https://developers.circle.com/wallets/user-controlled/authentication-methods
- https://developers.circle.com/wallets/user-controlled/build-a-wallet-app
- https://developers.circle.com/cctp/concepts/supported-chains-and-domains
- https://developers.circle.com/cctp/quickstarts/transfer-usdc-stellar-arc
- https://developers.circle.com/cctp/references/stellar

## Isolated stages

1. Record baseline, run existing TypeScript/lint/unit/build and Soroban suites,
   and add a content-hash regression check for the protected surface.
2. Add independent network configuration and additive Arc/Circle/bridge tables
   using the current SQL driver. Store USDC amounts as decimal integer strings.
   Scope all new records by explicit network, currency, contract, and token.
3. Build a separate Solidity escrow with exact USDC transfers, 90/5/5 fees,
   authorized settlement, bot liquidity, cancellation/refunds, expiry recovery,
   immutable financial parameters, and comprehensive security tests. Prepare
   deployment scripts that validate chain ID, token decimals, recipients, and
   bytecode. No production contract deployment before the required review.
4. Implement official Circle server/browser SDK integration. Bind wallet IDs to
   server-derived users, reconcile existing wallets before creation, use stable
   idempotency keys and database leases, and require explicit signing challenges.
5. Add separate Arc game APIs/queues/settlement and an Arc UI within the existing
   shared navigation. Network switching is explicit and never transfers funds or
   changes an external wallet. Preserve the Stellar paths and presentation.
6. Implement the official CCTP route and durable transaction tracking. Keep
   transfers disabled until both complete test flows pass; never fabricate fees,
   balances, attestations, or destination confirmations.
7. Run regression/security/UI checks; commit and push the feature branch; deploy
   Preview to the existing Vercel project; inspect it. Merge/promote only verified
   production-safe behavior. Activate each capability only when its credentials,
   contracts, authorization, and tests are present. Verify the live domains.

## Dependencies requiring user/external input

- Production and Preview Circle User-Controlled Wallets API keys and app IDs.
- Explicit Arc protocol and ecosystem 5% recipient EVM addresses.
- Required production financial-contract security review/audit.
- Arc signer is user-authorized; it must never be committed, logged, or exposed.
- Existing Stellar Mainnet deployment is absent from the audited live product;
  preservation takes precedence over an implicit Stellar migration.

This is an implementation plan and audit, not a claim that new features are live.
