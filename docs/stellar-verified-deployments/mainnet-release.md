# Stellar Mainnet release

On 2026-11-27 the owner approved deployment of the independently verified
escrow. The [Mainnet preflight](mainnet-preflight.json) confirmed the designated
signer, official Circle USDC and the absence of both the reviewed WASM and the
prepared instance on Mainnet. No deployment transaction was submitted.

The live WASM upload quote was **52.6051212 XLM**. The constructor needs a fresh
Mainnet simulation after upload. The same Testnet constructor was quoted at
**44.0641465 XLM** and charged **38.3163333 XLM**, so the preflight uses the
quoted amount to estimate funding. Including the USDC trustline fee, the estimate
was **96.6693677 XLM**. The deployment wallet had **53.3267381 XLM** available
after the account and trustline reserves, leaving an estimated shortfall of
**43.3426296 XLM**. A 65 XLM top-up gives room for fee changes. The deployment
runner enforces the recorded 110 XLM cap on this prepared deployment and checks
live reserves before signing each operation.

The rebuilt 39,385-byte WASM matches the independently verified Testnet artifact.
The production build, typecheck, lint, 350 application tests, 32 escrow tests,
compiled WASM resource probe and 9 deployment tests pass. The read-only
production audit still matches the saved wallet and key association fingerprints.

After funding, refresh the quote and verify the account can cover the full
estimate. Use the existing private signing configuration with the shared
production signer database. Keep the private state directory across retries so
the runner can recover exact signed envelopes and receipts.

```sh
npm run contract:wasm:mainnet
node scripts/stellar-mainnet-deploy.mjs --prepare --max-spend-xlm 110
node scripts/stellar-mainnet-deploy.mjs --execute --max-spend-xlm 110 --env-file /path/to/private-signing.env
node scripts/stellar-mainnet-deploy.mjs --verify --env-file /path/to/private-signing.env
```

The private signing file needs `ADMIN_WALLET_ADDRESS`, `SETTLEMENT_SECRET_KEY`
and `STELLAR_SIGNER_DATABASE_URL`. When production relies on its default
coordinator, the last value must point to the same database as production's
`DATABASE_URL`. Verify the deployment receipt, the live code and rules hashes,
the sole administrator and the official token before application validation.

Use an isolated Vercel validation environment with player-controlled signing,
the matching server and client contract pins, public Stellar gaming disabled and
only controlled testers on the allowlist. The minimum live two-player duel
requires two controlled wallets with 25 USDC each, authorized official USDC
trustlines, and XLM for reserves and fees. Confirm the 50 USDC pot, 45 USDC
payout and two 2.5 USDC fee allocations against chain receipts and application
history. Check an eligible refund, fees and permissions, and confirm duplicate
settlement cannot pay a second time. Complete wallet provider and Google/X login
checks, review live TTL and sponsorship costs, and reconcile existing player
wallets before activating public Mainnet gaming. Existing legacy wallet signer
changes require their own approved manifests and player signing ceremonies.
