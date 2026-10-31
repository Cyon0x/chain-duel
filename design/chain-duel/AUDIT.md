# Chain Duel redesign audit

Audit date: 2026-10-31. Starting revision: `46cb48c` on `main`.

## What was already uncommitted

There were 17 modified tracked presentation files: global styles/layout, home/play,
leaderboard/transactions, authentication, navigation, shared UI/lists, practice,
arena/results, computer presentation and the stake picker. Untracked work included
the horizontal adaptation of the original brand, arena artwork, licensed local
fonts, homepage/preview CSS modules, icons, target legend, public player activity,
shared mode links and three design explorations.

Those changes replaced the tall landing page with a two-column arena composition,
compact mobile hero, glass navigation and safe-area bottom tabs. Game rules,
authentication/wallet services, APIs, database code and the Soroban contract were
unchanged. Existing asset and configuration files were preserved.

## Work completed during this audit

| Brief requirement | Final implementation |
| --- | --- |
| Compact mobile homepage | Original brand in a horizontal lockup, readable headline, two actions, one connected statistics strip and short playable preview. No page scaling or zoom. |
| Desktop identity | Midnight arena scene, original metallic logo, cyan action and gold opponent/bonus cues, restrained glass navigation. |
| Real homepage data | Public player/leaderboard APIs, available public duel invitations, signed-in active/recent duels. Empty/loading/retry states use real responses. |
| Game arena | Actual player scores, clock, progress/combo, entry/pool, target symbols and responsive field. Existing deterministic engine and verified submissions retained. |
| Supporting mobile screens | Two-column profile/dashboard statistics, wrapping profile identities with separate mobile ratings/actions, compact queue and lobby, responsive invitation/QR layout, smaller metadata and settings controls. |
| Accessibility/motion | Modal focus trap/return, Escape dismissal, keyboard menus and stake presets, labelled touch-sized switches, High Contrast outlines, reduced motion, preview pause/resume. |
| Feature reachability | All original routes/providers retained; dashboard, wallet, settings and sign-out remain in account navigation; admin-only treasury link restored. |
| Honest demo presentation | Demo lobby/invitation/join text now explicitly says no stake/signature/funds. Queue says “Not matched” before a search begins. |
| Stake control consistency | Focusing an empty custom field now marks the amount invalid immediately; existing parser/bounds/payout math remain authoritative. Unique input/error IDs and keyboard preset selection added. |
| Documentation/collateral | Design direction, exploration files, audit/critique and reproducible browser QA. Existing 512px icon, 180px Apple icon and 1200×630 social image retained. |

## Preservation review

No changes to `src/lib/game`, `src/lib/services`, `src/lib/auth`, `src/lib/wallet`,
`src/lib/stellar`, `src/lib/db`, `src/app/api`, `contracts`, dependencies, environment
variable names or deployment configuration. Duration, spawn schedule, points,
combos, stakes, fees, payouts and settlement authority remain unchanged.

The application still supports Google/X OAuth, five Stellar wallet providers,
managed/external wallets, demo onboarding, public/online/friend/computer modes,
invitations and QR links, profiles/ratings, transactions and treasury administration.
Presentation corrections above do not authorize or simulate any wallet transaction.

## Verification

- TypeScript and ESLint pass; production build passes.
- Vitest: 157 passing tests; 14 tests in six opt-in live suites skipped in the
  ordinary run. Coverage includes engine/scoring, bots, rating/outcomes, wallet
  authentication, OAuth, security, stakes, invites, queue, escrow handoffs and API
  errors.
- Soroban: all 21 contract tests pass, including escrow/treasury invariants,
  authorization, refunds and duplicate settlement protection.
- Browser checks use isolated local SQLite databases, including a fresh
  `/private/tmp/chain-duel-audit/qa-production-final.db` for the final production-build run.
  All 16 public/account/supporting routes were rendered at 320×700, 375×812,
  390×844, 430×932, 768×1024, 1440×900 and 1920×1080 without horizontal overflow.
- Real UI handlers exercised: practice scoring/pause, sign-in modal and providers,
  demo onboarding, custom stakes, queue/cancel, private invite/QR/join, synchronized
  countdown, a full 60-second multiplayer duel, score verification and settlement,
  results, play-again, account navigation, persisted sound preference and sign-out.
  The final production run passed with no browser console/page errors. Eighteen-character
  usernames passed profile/dashboard/public-profile non-overlap assertions at all
  seven sizes. Both final displayed scores (2,614 and 2,564) and each viewer's
  WINNER/DEFEAT label matched the server's authoritative settlement.
- Design scan: baseline had five failure categories (small text, contrast,
  excessive glows and violet styling). Final homepage has no mechanical failures.
- Platform matrix: all 12 passes clean after fixing the theme control's High
  Contrast border. Covers Windows font metrics/scaling/scrollbars, Linux, Android,
  Firefox, WebKit desktop/iPhone, 320px reflow, reduced motion and text expansion.
- Reviewable before/after, arena/result/profile captures and reports are in
  `design/chain-duel/validation/`; full captures and motion frames remain in
  `/private/tmp/chain-duel-audit/`. The matrix PNG is a summary of all twelve passes;
  individual native-engine/emulation captures remain in the temporary directory.

Reproduce browser checks with `node scripts/ui-qa.mjs --out /tmp/chain-duel-qa`
against a local server using an isolated database. The script requires
`playwright-core` in the project or `UI_QA_PLAYWRIGHT_ROOT`; it also discovers the
installed web-designer tooling. It refuses external hosts and never stakes funds.
Start with a fresh database so abandoned queue tickets from interrupted runs do
not immediately match a new test identity. `--flows-only` skips the already-verified
supporting-route sweep while retaining profile and real gameplay assertions.

## Practical limits

Browser engines and font/scaling emulation do not prove physical device touch
latency, native Windows ClearType or screen-reader behavior. External wallet
signature dialogs and interactive Google/X authorization require the user's
provider session; these were not completed with personal accounts. Their existing
handlers and providers remain connected, with unit/integration checks passing.

Existing toolchain notices remain: experimental Node SQLite and deprecated Soroban
event publishing; the build also reports the existing PostgreSQL SSL-mode future
compatibility notice. These are outside the presentation change.

The existing computer-availability panel gates the computer screen on treasury
availability, including its demo selector. The live treasury was available during
this audit; its guard and server behavior were preserved.

An earlier result capture showed equal scores beside WINNER. Reading the isolated
database confirmed both were 2,429: this was the existing server tiebreak, not an
animation or invented outcome. `winnerOf` sorts by score, then maximum combo, then
seat. This redesign preserves that behavior and checks result labels against the
recorded winner rather than redefining tied outcomes.

## Adding matching screens

Use the roles/tokens in `src/app/globals.css`, shared controls in
`src/components/ui.tsx`, and scoped CSS modules for page composition. Keep real
states/data in the existing service layer. Use a two-column phone readout grid,
44px primary touch controls and 12px-or-larger metadata; account for the safe-area
navigation when adding fixed controls.
