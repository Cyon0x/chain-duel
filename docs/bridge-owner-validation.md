# Verified Stellar–Arc Mainnet bridge

Status: 2026-11-23. Both 0.10 USDC Mainnet directions completed and their actual
source and destination receipts were verified. Circle's executed standard-transfer
fee was zero in both directions. This verifies the official CCTP route for the
existing managed Stellar wallet and Circle user-controlled Arc wallet.

Public bridging is active at https://www.chainduel.site/bridge and
https://chain-duel.vercel.app/bridge. PR #4 was merged into `main` at
`225e01159c4ade28f70f207fca2128ee6e5fd816`. Vercel deployment
`dpl_4obwHzaqcE75eF1dwJofdjoAaAYm` is READY in Production; both domains,
public availability, PostgreSQL persistence, OAuth routing, all 12 pages and
game/mint browser fixtures passed. The existing canonical Arc OAuth origin
remains `https://chain-duel.vercel.app`. All other environment settings and
all 117 protected Stellar files are unchanged.

| Direction | Source burn | Destination settlement | USDC minted |
| --- | --- | --- | --- |
| Arc → Stellar | [Arc burn](https://explorer.arc.io/tx/0x784426a148fee8c5dcf1453363b58a6a8e954807d445914e8b59d8375b1555a2) | [Stellar mint and forwarding](https://stellar.expert/explorer/public/tx/649102fec2d788e93af76807b38de4dd83ad1f17f561e3eb377a80944deb7663) | 0.10 |
| Stellar → Arc | [Stellar burn](https://stellar.expert/explorer/public/tx/22616a5cc3f82d80fd2d9e82ca6bf0c21706764e4fb86e0106d7435b1e9ed4d6) | [Arc mint](https://explorer.arc.io/tx/0x2acb634e7f04a5324ca02ce96625f22ca51751de6802e3a5000922944aeacab6) | 0.10 |

Forward transfer: `7f05b5d6-71b6-4750-b766-c2c0daba9326`.
Return transfer: `5748415a-f5f3-44de-8d77-79d3a7e0452f`.
The Stellar USDC contract is
`CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`.
Arc USDC remains `0x3600000000000000000000000000000000000000`.
Public evidence is recorded in `bridge-deployments/owner-flow-mainnet.json`.

The Arc source receipt verifies wallet funding of Circle's official local minter,
its exact six-decimal USDC burn and the emitted source message. The Stellar
mint-and-forward invocation matches the saved message and attestation, and its
USDC event credits the saved recipient with 1,000,000 seven-decimal units.

The return's Stellar allowance and burn envelopes match the persisted
owner-approved signed bytes and exact invocation arguments. The official USDC
token debits 1,000,000 seven-decimal units; its emitted CCTP message matches
Circle's attestation. The Arc receipt verifies the expected transmitter calldata,
MessageReceived event, consumed nonce and exact 100,000 six-decimal USDC mint.
Its block-32751490 native balance change reconciles exactly with the 0.10 USDC
credit less 0.00785866218592266 USDC in actual gas.

Final checked balances: 0.371883 USDC on Arc; 0.0000000 USDC and 4.9728588 XLM on
Stellar Mainnet. The existing wallet identities and Stellar gaming configuration
were preserved. Existing Stellar XLM games remain Testnet.

Repeated confirmed approvals return without creating a signing challenge.
Repeated refresh preserves both completed receipts. Destination recovery accepts
the actual verified Arc mint hash and rejects an unrelated source transaction.
A live Circle fee quote passes a funded gas-only request and rejects a full-wallet
USDC debit that cannot also reserve gas, before any signature. A prior expired
Mainnet Circle authorization was observed; bridge regression tests confirm that
expired allowance approvals are archived before retry and expired burn attempts
require a new reviewed transfer. Verification created no financial challenge and
executed no financial transaction.

The initial Preview exception limited the authenticated owner to 0.10 USDC while
public access remained disabled. With both directions verified, the release uses:

- `BRIDGE_ENABLED=true`.
- `BRIDGE_E2E_VERIFIED=true`.
- `BRIDGE_SECURITY_REVIEWED=true`.

The public route takes precedence over owner validation and removes its temporary
cap. Every new transfer still requires the authenticated wallet owner to review
and approve each step. Public rollout and deployment evidence are recorded in the
release report and `bridge-deployments/owner-flow-mainnet.json`.

Validation passed: 276 application tests, TypeScript, ESLint and optimized build;
42 focused bridge/configuration/routing tests passed again for this release.
The prior 16 Arc Solidity tests with 256 conservation fuzz cases, 23 Soroban tests
and isolated PostgreSQL migration regression passed; the contract and database
implementations are unchanged. All 117 protected Stellar files still match the
baseline. Browser fixtures passed 18 combinations of ready Arc/Stellar mints,
waiting attestations, submitted mints, failed-mint retry and completed outcomes
at 390, 768 and 1440 pixels without page errors, authorization or horizontal
overflow. These fixtures are distinct from the real financial receipt evidence.
No independent third-party certification is claimed.
