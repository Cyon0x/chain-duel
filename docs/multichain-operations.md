# Multi-chain implementation and activation

Baseline: `898340b24c45211690725158fa3bfab207ef4bd2`.
Feature branch: `feat/multichain-arc-circle`.

## Architecture and preserved Stellar behavior

Chain Duel retains one Next.js application, authentication system, profile and
PostgreSQL database. Navigation selects the ecosystem explicitly. Existing
Stellar routes, Soroban contracts, deployment addresses, account creation,
encrypted wallet storage, queues, verification and 90/10 economics are preserved.
`npm run stellar:regression` compares 117 protected files to the baseline.

The audited production deployment runs Stellar **Testnet**, with 90% paid to the
winner and 10% accrued to its original protocol treasury. This release does not
change that network or its fee model. Stellar Mainnet gaming remains a separate
deployment requirement under the preservation instruction.

Arc lives in `src/lib/arc`, `/api/arc`, `/arc`, and `contracts/arc`. Its tables are
additive and retain network IDs, currency, token, escrow address and integer USDC
amounts. Original rows are neither migrated destructively nor overwritten.
Read-only Stellar views expose inferred historical network identifiers without
changing the original ledger. Every Arc queue is scoped by network, USDC, game
type, mode and exact stake. The original Stellar APIs reject Arc/USDC requests at
the shared routing boundary.

Arc's official Mainnet is chain 5042, RPC `https://rpc.mainnet.arc.io`, explorer
`https://explorer.arc.io`; Testnet is chain 5042002. ERC-20 USDC at
`0x3600000000000000000000000000000000000000` has six decimals; native USDC gas has
18 decimals and represents the same balance. Runtime requests verify chain ID
and token decimals. Indexing uses the correct emitter and decimal precision.

## Circle onboarding and wallet ownership

Official packages: `@circle-fin/user-controlled-wallets` and
`@circle-fin/w3s-pw-web-sdk`. Both existing Google and X OAuth account identities
use Circle's supported **User-Controlled Wallets PIN** architecture. Circle's
native social providers include Google, Apple and Facebook; X is not a native
Circle social provider. No replacement or invented X OAuth integration is used.

After authentication, the shared provider automatically initiates provisioning
when configured. A stable Circle user ID derives from the verified application
user and Circle app ID. Server reconciliation checks the upstream wallet owner,
custody, blockchain and live state before saving an association. Unique database
constraints, leases and stable idempotency keys prevent repeated wallet creation.

The user must finish Circle's PIN/recovery setup before an address is marked
ready. The browser SDK receives scoped authentication tokens; PINs and recovery
answers remain within Circle's SDK. Each game or bridge transaction uses an
explicit Circle signing challenge. Wallet address, copy/receive, genuine balance,
transaction references and PIN recovery are available in the wallet interface.
The app never stores an Arc private key for a user. API secrets stay server-side.

Required environment settings:

- `CIRCLE_API_KEY`, server-only; live key for Mainnet, test key for Preview/Testnet.
- `NEXT_PUBLIC_CIRCLE_APP_ID`, the corresponding public Circle application ID.
- `ARC_NETWORK=mainnet|testnet` and `ARC_WALLETS_ENABLED=true` after real testing.

Circle credentials were unavailable during implementation. SDK/API boundary tests
use test doubles; they do not establish successful live Google/X wallet
provisioning, signing or recovery. Activation must wait for those real checks.

## Arc escrow and deployment

`ChainDuelArc.sol` is an independent, non-upgradeable OpenZeppelin-based escrow.
It supports private/PvP/bot entries, joining, authorized start and settlement,
90/5/5 payout, configurable deployment recipients, prefunded bot liquidity,
cancellation and permissionless timed refunds. Settlement uses the existing
deterministic game engine and server event-log verifier. The authority is trusted
to report the verified winner; the contract restricts payouts to its participants.
Paused entry does not prevent settlement or refunds. No administrative rescue
function can withdraw player escrow or change immutable fee destinations.

Tests cover reentrancy, incorrect tokens, transfer-tax/false-return tokens,
authorization, duplicate settlement, rounding/conservation, cancellation,
stalled games and bot accounting. Passing tests do not certify a production audit.
Direct contract joins can bypass the app lobby; participant mismatches are flagged
for recovery and settlement is blocked. This behavior must be included in review.

Run `npm run arc:test`, `npm run arc:abi`, and `npm run arc:review:manifest`.
The build manifest binds every source/dependency, creation bytecode and compiler
settings. It has `approved:false`; it is evidence for a reviewer, not an audit.
Preparation validates official RPC/token configuration and explicit parameters:

- `ARC_OWNER_ADDRESS`, `ARC_SETTLEMENT_AUTHORITY`, `ARC_BOT_TREASURY`.
- `ARC_PROTOCOL_FEE_RECIPIENT`, `ARC_ECOSYSTEM_FEE_RECIPIENT`.
- `ARC_MIN_STAKE_USDC`, `ARC_MAX_STAKE_USDC` (exact decimal strings).

`npm run arc:deploy:prepare` saves reviewed parameter details without sending a
transaction. Mainnet broadcast additionally requires `ARC_REVIEW_REPORT`, approving
`sourceSha256`, `sourcesSha256`, `creationBytecodeSha256` and
`constructorArgumentsSha256`, with `approved:true` and an audit reference.
Use `node scripts/arc-deploy.mjs --broadcast` only after the review and verified
parameters. `ARC_DEPLOYER_KEY_FILE` must be owner-private and outside this repo.
The user authorized the supplied signer; no new deployment wallet is generated.

The script records transaction hash, address, block, timestamp, network and
constructor checks. Explorer source verification remains an explicit release
requirement. No Arc contract address or deployment transaction exists until an
actual successful broadcast; no Stellar contract is redeployed.

Runtime gaming needs `ARC_DUEL_CONTRACT_ADDRESS`, a securely configured
`ARC_SETTLEMENT_PRIVATE_KEY` (or local private file), `ARC_CONTRACT_REVIEWED=true`
and `ARC_GAMING_ENABLED=true`. Confirm the configured signer matches the on-chain
authority. Fund bot reserves separately using the approved treasury.

## Official CCTP USDC transfers

Circle CCTP V2 officially supports Stellar domain 27 and Arc domain 26 in both
directions on Mainnet and Testnet. The implementation uses the published
TokenMessenger/MessageTransmitter addresses and Stellar CctpForwarder, with
standard finality 2000. Inbound Stellar routes set both mintRecipient and
destinationCaller to the forwarder and encode the verified Stellar recipient in
its hook. The app does not construct an alternative bridge.

Stellar USDC configuration follows `ARC_NETWORK` independently of XLM gaming.
The same authenticated managed Stellar G-address is verified using the existing
signer. A Mainnet account needs activation, XLM gas and the official USDC trustline;
the app does not silently create a new key, change wallet records or move XLM.
Bridge amounts are six-decimal integers. Stellar source inputs scale to seven
decimals, preserving seventh-decimal dust. Destination conversion is handled by
Circle's official contracts.

`/api/bridge` implements quote, create, prepare, approve, refresh, cancel and
destination recovery. Circle fees are queried dynamically. Network fees are
estimated for each step; no constant estimate is presented as a real quote.
Both Arc source and Arc destination steps use the user's Circle wallet, which
needs USDC for gas. Stellar steps use the existing managed signer only after an
explicit approval. The signed XDR and its hash are persisted **before** sending.
Uncertain burns are never recreated. Failed non-burn attempts are archived before
retrying; known failed source burns use a new reviewed transfer request.

Attestations must match source/destination domains, messenger contracts, token,
sender, recipient, amount, fee, finality, forwarder hook and saved nonce/hash.
Only a verified successful destination mint marks completion. Arc verification
requires the expected transmitter call, MessageReceived, consumed nonce and
correct six-decimal USDC mint event. Stellar verification requires a successful
atomic mint-and-forward invocation with the exact validated message/attestation.
Externally completed mints can be recovered using a verified destination hash.

Activation requires `BRIDGE_ENABLED=true`, `BRIDGE_E2E_VERIFIED=true`,
`BRIDGE_SECURITY_REVIEWED=true`, configured Circle wallets and real two-direction
tests including destination settlement, insufficient gas, duplicate submission,
expired authorization and recovery. Those tests have not been run with real
Circle credentials. **No bridge route is active yet.**

## Deployment and remaining verification

Use the existing GitHub repository and Vercel `chain-duel` project, production
branch `main`. Branch-specific Preview persistence uses the separate Neon schema
`chain_duel_multichain_preview`. Existing production data and Stellar environment
values are preserved. Verify Preview before integration, then inspect actual
production pages, network endpoints, build logs and the existing domain.

Safe defaults keep Arc signing/gaming and CCTP transfers inactive. Real balances,
wallets and transaction success are never fabricated. The release status report
must distinguish deployed navigation/backend code from financial activation.

Remaining external requirements: Circle credentials and real social-wallet tests,
verified Arc recipients/limits/authority, approved financial-contract review,
Arc broadcast/source verification/runtime signer/bot funding, and genuine CCTP
tests in both directions. The overall Mainnet expansion is incomplete until these
are met.

Official references: [Arc connection](https://docs.arc.io/arc/references/connect-to-arc),
[USDC event model](https://docs.arc.io/arc/references/usdc-system-events),
[Circle authentication](https://developers.circle.com/wallets/user-controlled/authentication-methods),
[Circle Stellar–Arc guide](https://developers.circle.com/cctp/quickstarts/transfer-usdc-stellar-arc),
[Stellar forwarding](https://developers.circle.com/cctp/references/stellar).
