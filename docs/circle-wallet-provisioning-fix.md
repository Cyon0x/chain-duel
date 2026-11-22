# Circle wallet provisioning correction

Verified on 2026-11-22.

## Cause and correction

Arc wallet reconciliation requested `pageSize=100` from Circle's list-wallets
endpoint. Circle accepts values from 1 to 50 and rejected the request with HTTP
400, provider code 2, before wallet authorization could be prepared. The API
returned the application's sanitized Arc service error.

Wallet lookup now requests 50 records per page and retains cursor pagination and
ownership, custody, blockchain and address checks. The account association and
wallet creation idempotency keys are preserved. No Stellar code, records, contract
configuration or environment settings were changed by this correction.

Official reference:
https://developers.circle.com/api-reference/wallets/user-controlled-wallets/list-wallets

## Verification

- The live Circle API accepted page sizes 10 and 50 and rejected 100 for the same
  authenticated user and Arc Mainnet configuration.
- Cyon0x's verified Google account was found in the isolated Preview database.
  The corrected implementation prepared a live `PENDING` PIN setup challenge.
  A second provisioning call returned the same challenge and idempotency key.
- The user's existing account, profile, Stellar wallet and wallet-key records
  were compared before and after provisioning and were unchanged.
- Regression coverage rejects oversized provider requests and checks retrieval
  of a 51st wallet through the next cursor page.
- 260 application tests passed; 16 opt-in tests skipped. TypeScript, ESLint,
  production build and the 117-file Stellar preservation check passed.

## Owner action still required

Preparing a challenge does not create or authorize a wallet. The account owner
must complete Circle's PIN and recovery prompts. No PIN was set on the owner's
behalf and no financial transaction was executed during this verification. Arc
gaming and bridge activation remain gated on their existing real-flow checks.
