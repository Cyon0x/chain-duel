# Stellar Mainnet bridge validation

Status: 2026-11-23. The owner's 0.10 USDC Arc-to-Stellar transfer completed.
The Arc allowance and burn, Circle attestation, Stellar USDC trustline and
atomic destination mint-and-forward were checked against their actual receipts.
The official Stellar USDC token credited the saved recipient with 1,000,000
seven-decimal units, or 0.1000000 USDC. Circle's executed transfer fee was zero.

The 0.10 USDC Stellar-to-Arc return's allowance and source burn also completed.
Their on-chain envelopes match the persisted owner-approved signed transactions,
and the official Stellar USDC token debited exactly 1,000,000 seven-decimal units.
The emitted CCTP source message matches Circle's verified attestation.
The final Arc mint review is prepared and awaits the owner's Circle PIN approval.
No destination mint or completed return is claimed yet.

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
Return transfer awaiting its final mint: `5748415a-f5f3-44de-8d77-79d3a7e0452f`.
Destination USDC contract:
`CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`.
The return quote has a zero maximum standard-transfer fee and a minimum 0.10
USDC received. Its initial Stellar allowance review estimates 0.0013267 XLM;
network fees are re-estimated when each step is reviewed. At verification, the
wallets held 0.1000000 USDC and 4.9750686 XLM on Stellar, and 0.279742 USDC on Arc
before the return. After its confirmed source burn, Stellar holds 0.0000000 USDC
and 4.9728588 XLM; Arc still holds 0.279742 USDC. The initial final-mint review
estimates approximately 0.004974 USDC in Arc gas; fees are checked again before
the Circle signing challenge.

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

Verified return source receipts:

- [Stellar allowance](https://stellar.expert/explorer/public/tx/5138c9cd776be9bf0c4f75deaa0f503e95216ec7b1d0ce6f2e90abb8a499f35a).
- [Stellar burn](https://stellar.expert/explorer/public/tx/22616a5cc3f82d80fd2d9e82ca6bf0c21706764e4fb86e0106d7435b1e9ed4d6).

The owner opens https://chain-duel-multichain-preview.vercel.app/bridge as Cyon0x
and selects **View transfer** for the 0.10 USDC **Ready to mint on Arc** record.
Select **Review: Mint destination USDC**, then **Approve mint destination USDC**
and complete the Circle PIN authorization. Public activation remains gated on
the verified Arc destination receipt and remaining release checks.

Ready mints now display the destination network and a final-approval notice.
Submitted mints retain their pending label and receipt link while confirmation
is checked. A known failed mint remains reviewable for retry; completed transfers
retain their verified outcome and destination settlement link. The server's
receipt verification and transaction state machine are unchanged.

Validation passed again on 2026-11-23: 276 application tests, TypeScript, ESLint,
optimized production build, 16 Arc Solidity tests with 256 conservation fuzz
cases, 23 original Soroban tests and the isolated PostgreSQL migration regression.
All 117 protected Stellar files remain unchanged. The owner boundary,
Production exclusion, upstream configuration requirement, exact cap and saved
oversized-transfer rejection are regression-tested. The deployed Preview passed
12 pages and its backend, OAuth and network checks. Browser fixtures using the
verified receipt metadata passed completed-transfer links and the unsigned return
review at 390, 768 and 1440 pixels, with no page errors or horizontal overflow.
The latest mint-state browser fixtures also passed 18 combinations covering ready
Arc/Stellar mints, waiting attestations, submitted mints, failed-mint retries and
completed transfers at the same three widths. New regression cases verify that
expired allowance approvals are archived before retry and expired burn attempts
remain terminal until a new transfer is reviewed.
The forward transfer is a completed live bridge test. The return's source and
attestation are verified; its Arc destination mint remains outstanding.
No independent third-party certification is claimed.
