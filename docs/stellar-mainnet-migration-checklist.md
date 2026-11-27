# Stellar Mainnet USDC migration checklist

Started 2026-11-24 against `89eb64284399d1fdfbe03eafa00614dc4e5bec50`.
This checklist precedes implementation and deployment. Unchecked items are not verified.

## Investigation findings

- The existing Stellar implementation is **XLM / Stellar Testnet / 90% winner and
  one 10% treasury fee**. The 90/5/5 USDC implementation belongs to Arc. The requested
  Stellar Mainnet release therefore needs separate protocol/ecosystem accounting;
  it is not an endpoint-only migration.
- One Soroban contract family contains escrow, settlement, refunds, bot liquidity,
  fees and configuration: `contracts/chain_duel/src/lib.rs`.
- Original Testnet escrow: `CBBDWEWBBQVQXNYUJ4FA6C2CXXUVDAJSNUOVPZNKTQWK5P2EON7KEGMZ`.
- Testnet stake revision: `CD3EW4ENWDYGOGQGBJ7G2NU2YV4MLGSQW7CEIBZOYR2NQ4NJ7ZIOZ6FA`.
- Testnet native XLM SAC: `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`.
- Existing WASM path: `contracts/chain_duel/target/wasm32v1-none/release/chain_duel.wasm`.
- Dependencies: Soroban SDK 28.0.0, Rust 1.92, Stellar JS SDK 17.2.1,
  Stellar Wallets Kit 2.7.0, Freighter API 6.0.1, Next.js 16.4.6.
- Server signing uses `SETTLEMENT_SECRET_KEY`; managed player keys remain encrypted
  with the existing `WALLET_ENCRYPTION_KEY`. Neither key is exposed in this report.
- The configured key derives the exact designated address:
  `GCQKVXWIQHVGUOUHZR2O6YBWBNNPKIYH5AWQHXHF3EYRHM73WIWVSK7K`.
- Mainnet wallet initially observed with 4.4719381 XLM, no trustlines and no other
  account signers. With the current 0.5 XLM base reserve, the account reserve is
  1 XLM and 3.4719381 XLM remains before fees. A USDC trustline adds another
  0.5 XLM reserve; deployment estimates must account for it.
- Mainnet RPC reports `Public Global Stellar Network ; September 2015`, protocol 30.
- Circle's official Mainnet USDC issuer is
  `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`:
  <https://developers.circle.com/stablecoins/usdc-contract-addresses>.
  The expected SAC is `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`;
  SDK derivation and on-chain decimals/token identity still require verification.
- Historical games bind a contract ID but not its network or currency. Their
  network/token must be preserved before enabling Mainnet; XLM history must not
  be relabeled USDC or submitted to Mainnet.
- Browser wallet code imports server environment configuration and can default
  to Testnet. It needs public runtime configuration and the prepared transaction's
  actual network, including legacy Testnet recovery.
- Existing Stellar entry bounds are 25–10,000 units per player; presets are
  50/100/200/500/1,000/2,000/5,000/10,000. The requested USDC migration preserves
  those numeric options and all gameplay rules. A real minimum PvP test therefore
  locks **50 USDC**, not 0.10 USDC; it requires the owner's explicit financial approval.
- The existing computer-game availability reserve is 100 units. Preserve this
  operational limit when evaluating USDC test capital and bot readiness.
- Baseline: 276 application tests passed, 16 opt-in live tests skipped;
  all 23 original Soroban tests passed. No Mainnet financial test is implied.

## 1. Architecture and migration inventory

- [x] Identify existing contract source, Testnet IDs, token, SDKs and signer.
- [x] Read installed Next.js environment, route-handler and server/client guidance.
- [x] Run existing offline application and Soroban suites.
- [ ] Record Testnet references by purpose: active configuration, recovery,
  test fixtures, operational scripts and historical documentation.
- [ ] Verify both existing Testnet deployments and their actual configuration.
- [ ] Record WASM artifacts, hashes, build commands and dependencies.
- [ ] Map all entry, join, settlement, refund, fee and withdrawal routes.
- [ ] Snapshot gameplay/Arc files and existing database counts for preservation checks.

## 2. Designated deployment wallet and spending preflight

- [x] Derive and verify the exact designated public address without logging its seed.
- [x] Verify Mainnet account existence, initial balance and account signers.
- [ ] Verify current base reserve, liabilities, sponsorship and available balance.
- [ ] Simulate exact upload; estimate initialization and maintenance costs.
- [ ] Publish a bounded XLM expenditure plan and recheck balance before signing.
- [ ] Include USDC trustline reserve/fee if required for fee receipts and bot payouts.
- [ ] Persist deployment intents outside Git so retries cannot create duplicate contracts.

## 3. Administrative ownership and accounting

- [x] Owner approved separate 5% protocol/5% ecosystem buckets collected by the
  designated wallet, which also holds the ecosystem allocation (2026-11-24).
- [ ] Define one Chain Duel Mainnet escrow contract; avoid unnecessary auxiliary deployments.
- [ ] Initialize deployer/admin/treasury/protocol collector to the designated wallet.
- [ ] Keep ecosystem withdrawal authority with that same wallet and record its
  explicitly approved beneficiary/accounting.
- [ ] Prevent unintended external administrators or fee/treasury redirection.
- [ ] Protect locked stakes, refunds and payouts from treasury withdrawals.
- [ ] Snapshot fees per game; maintain independent buckets and conservation.
- [ ] Preserve score/combo/seat winner determination and automatic settlement.
- [ ] Audit duplicate settlement, replay, refunds, arithmetic and privileged operations.
- [ ] Document the trusted off-chain verifier and official USDC issuer boundaries.

## 4. Contract build, tests and deployment

- [ ] Preserve legacy contract source/instances; create a Mainnet revision only as needed.
- [ ] Compile and test Mainnet contract with actual authorization checks.
- [ ] Verify entry boundaries, bot wins/losses, PvP, refunds and fee conservation.
- [ ] Verify WASM SHA-256 and inspect the exported interface.
- [ ] Deploy only after the spending preflight passes, using the designated signer.
- [ ] Record upload/deployment/atomic constructor hashes and all parameters.
- [ ] Independently read code, initialized state and admin permissions on Mainnet.
- [ ] Verify instance/code lifetime and recovery/maintenance procedures.

## 5. Mainnet USDC and wallet integration

- [ ] Derive the Circle USDC SAC from the official issuer and Mainnet passphrase.
- [ ] Verify on-chain token identity and seven-decimal precision.
- [ ] Separate USDC balances/stakes/payouts from XLM network gas and reserves.
- [ ] Preserve XLM wallet transfers while supporting USDC transfers and trustlines.
- [ ] Preserve managed keys, wallet associations, Google/X auth and player profiles.
- [ ] Verify Wallets Kit's Freighter/xBull/LOBSTR/Albedo/Rabet adapters and explicit network signing.
- [ ] Reject stale or substituted chain/currency requests before signing.

## 6. Application and data cutover

- [ ] Add immutable network/currency/token context to games and financial history.
- [ ] Preserve old Testnet escrow, refunds, settlements and explorer URLs.
- [ ] Keep Mainnet/legacy statistics, matchmaking and monetary totals distinct.
- [ ] Update only necessary asset/network labels; preserve layouts and game mechanics.
- [ ] Update backend/frontend public configuration together; exclude all signing secrets.
- [ ] Maintain Arc contracts, wallets, credentials, economics and bridge behavior.
- [ ] Apply additive database migrations and verify existing records/profile associations.
- [ ] Validate on isolated Preview before production activation.
- [ ] Push reviewed/tested changes to GitHub and deploy Vercel as already authorized.

## 7. Live financial tests and three verification passes

- [ ] Prepare a concrete owner-only USDC test plan with amounts, destinations,
  expected payouts/fees, capital held in the bot pool and XLM network costs.
- [ ] Obtain explicit approval before meaningful USDC movements or withdrawals;
  do not use real player funds or alter minimum stakes to make tests cheaper.
- [ ] Record expected/actual outcomes and transaction hashes for every live test.
- [ ] Verify deposit/join/lock/gameplay/winner/payout/fees/history/balances.
- [ ] Verify authorized fee collection, unauthorized rejection, refunds and replay rejection.
- [ ] Pass 1: cross-check all public/private configuration without exposing secrets.
- [ ] Pass 2: verify contract/code/admin/token/fees and receipts through Mainnet infrastructure.
- [ ] Pass 3: verify the deployed application and actual wallet/financial flows.
- [ ] Record any manual wallet-provider/OAuth checks honestly; fixtures are not live proofs.

## 8. Final report and readiness

- [ ] Provide deployment wallet balances and exact XLM expenditure.
- [ ] Provide every contract ID, WASM hash, deployment/init receipt and admin.
- [ ] Provide an address-by-address permission matrix.
- [ ] Explain the 100 USDC example: 90 winner, 5 protocol, 5 ecosystem;
  Stellar transaction/resource fees are separate XLM charges.
- [ ] List all modified files, preserved features, completed checks and outstanding failures.
- [ ] Declare **READY FOR STELLAR MAINNET USERS** only if all critical live checks
  pass; otherwise declare **NOT READY: BLOCKING ISSUES REMAIN** with exact blockers.

## Authorization boundaries

Mainnet deployment/initialization and assigning the designated administrative wallet
are authorized. The owner requires explicit approval for unrelated-address transfers,
existing-contract withdrawals, redirection of existing funds, changing ecosystem
beneficiaries, fee percentages or game mechanics, destructive upgrades, and real-player
funds in tests. No secret, signed envelope or credential belongs in Git or public output.
