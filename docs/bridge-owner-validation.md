# Funded Stellar Mainnet bridge validation

Status: 2026-11-22. The owner's existing Stellar address is active on Mainnet
with 5.0001 XLM. It has no USDC trustline yet. A 0.10 USDC Arc-to-Stellar
transfer and unsigned trustline request have been prepared; nothing has been
signed or transferred by this preparation.

The existing feature-branch Preview permits the configured authenticated owner
to validate transfers up to 0.10 USDC. Other Preview accounts and anonymous
requests remain disabled. Production cannot use this exception. Public bridge
activation and `BRIDGE_E2E_VERIFIED` remain false until both real directions and
destination settlement have passed. The cap is enforced on quotes, creation,
prepared steps and authorization, including oversized previously saved records.

Server settings on Preview only:

- `BRIDGE_VALIDATION_ENABLED=true`.
- `BRIDGE_VALIDATION_USER_ID` identifies the authenticated owner.
- `BRIDGE_SECURITY_REVIEWED=true` records the existing engineering review.
- `BRIDGE_ENABLED=false` and `BRIDGE_E2E_VERIFIED=false`.

Quotes, wallet matching and unsigned Stellar preparation read the existing
managed wallet's public identity and check that its sealed signing record exists.
Key decryption and signing still happen only
through the unchanged server signer after the approval step. No signing key,
PIN, session token or owner user ID is stored in this document.

Prepared transfer: `7f05b5d6-71b6-4750-b766-c2c0daba9326`.
Destination USDC contract:
`CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`.
Circle quoted zero standard-transfer fee and a minimum 0.10 USDC received.
The classic trustline transaction quoted 100 stroops / 0.00001 XLM in fees.
Network fees for later Arc and Stellar steps are estimated separately.

The owner opens https://chain-duel-multichain-preview.vercel.app/bridge and
selects **View transfer** for the prepared 0.10 USDC record. Each step must be
reviewed and approved: Stellar trustline, Arc USDC allowance, Arc burn and
Stellar destination mint. Arc signing requires the owner's Circle PIN. Once
destination settlement is verified, the return direction is tested separately.

Validation passed: 274 application tests, TypeScript, ESLint and production
build. All 117 protected Stellar files remain unchanged. The owner boundary,
Production exclusion, upstream configuration requirement, exact cap and saved
oversized-transfer rejection are regression-tested. This is preparation evidence,
not a completed bridge test or independent third-party certification.
