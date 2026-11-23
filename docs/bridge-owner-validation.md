# Stellar Mainnet bridge validation

Status: 2026-11-23. The owner's 0.10 USDC Arc-to-Stellar transfer completed.
The Arc allowance and burn, Circle attestation, Stellar USDC trustline and
atomic destination mint-and-forward were checked against their actual receipts.
The official Stellar USDC token credited the saved recipient with 1,000,000
seven-decimal units, or 0.1000000 USDC. Circle's executed transfer fee was zero.

The 0.10 USDC Stellar-to-Arc return is saved with an unsigned Stellar allowance
review. Its preparation did not sign, burn or move funds. The return still needs
the owner's allowance, burn and destination mint approvals and receipt verification.

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

Completed forward transfer: `7f05b5d6-71b6-4750-b766-c2c0daba9326`.
Prepared return transfer: `5748415a-f5f3-44de-8d77-79d3a7e0452f`.
Destination USDC contract:
`CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`.
The return quote has a zero maximum standard-transfer fee and a minimum 0.10
USDC received. Its initial Stellar allowance review estimates 0.0013267 XLM;
network fees are re-estimated when each step is reviewed. At verification, the
wallets held 0.1000000 USDC and 4.9750686 XLM on Stellar, and 0.279742 USDC on Arc.

Forward receipts:

- [Arc allowance](https://explorer.arc.io/tx/0x43fa630442acabc93871a088de1fcf2709da5099eb02384e59930af5cf804db7).
- [Arc burn](https://explorer.arc.io/tx/0x784426a148fee8c5dcf1453363b58a6a8e954807d445914e8b59d8375b1555a2).
- [Stellar trustline](https://stellar.expert/explorer/public/tx/ff06b10703ba7f0ce808362cee774f9ecc7aafe3cca3f11996ad858b30fdb1a5).
- [Stellar mint and forwarding](https://stellar.expert/explorer/public/tx/649102fec2d788e93af76807b38de4dd83ad1f17f561e3eb377a80944deb7663).

The burn receipt includes the approved transfer from the owner to Circle's
official local minter, followed by that minter's exact USDC burn. Its emitted
source message matches the immutable fields in Circle's attested message.
The successful Stellar invocation uses the exact saved message and attestation,
and its official USDC forwarding event identifies the saved recipient and amount.
Repeated refresh preserves the completed transfer and all receipt references.
Public evidence is recorded in `bridge-deployments/owner-flow-mainnet.json`.

The owner opens https://chain-duel-multichain-preview.vercel.app/bridge as Cyon0x
and selects **View transfer** for the 0.10 USDC **Awaiting approval** record.
The return requires separate reviews and approvals for the Stellar USDC allowance,
Stellar source burn and Arc destination mint. Arc signing requires the owner's
Circle PIN. Public activation remains gated on the verified return and remaining
release checks.

Validation passed again on 2026-11-23: 274 application tests, TypeScript, ESLint,
optimized production build, 16 Arc Solidity tests with 256 conservation fuzz
cases, 23 original Soroban tests and the isolated PostgreSQL migration regression.
All 117 protected Stellar files remain unchanged. The owner boundary,
Production exclusion, upstream configuration requirement, exact cap and saved
oversized-transfer rejection are regression-tested. The deployed Preview passed
12 pages and its backend, OAuth and network checks. Browser fixtures using the
verified receipt metadata passed completed-transfer links and the unsigned return
review at 390, 768 and 1440 pixels, with no page errors or horizontal overflow.
The forward transfer is a
completed live bridge test; the prepared return is not yet a verified transfer.
No independent third-party certification is claimed.
