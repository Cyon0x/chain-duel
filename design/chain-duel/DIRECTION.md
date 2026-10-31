# Chain Duel — arena glass

## Brief

User-provided brief: redesign the existing Next.js gaming application; preserve its logo, Stellar Testnet integration, real authentication, wallets, invitations, matchmaking, gameplay, settlement, profiles and transaction history. Mobile density is the first visual priority. Implement, validate, push to GitHub and deploy to Vercel.

The first ten seconds should explain Pulse Duel and make entering or practising easy. The product should feel precise, immersive and responsive. The supplied cosmic arena artwork and desktop/mobile mockups are the primary direction. MotionSites, Vibrant Design and Insposite inform motion, composition and finish. The installed Web Designer and App Designer resources inform responsive layout, typography, safe areas and accessibility; native iPhone device chrome is not part of the website.

## Current

Next.js 16.3.8 App Router, React 19, Tailwind 4, existing Framer Motion and Stellar SDKs. The landing page uses a tall logo, a 320/380px preview, 96/112px section gaps and several repeated promotional sections. Metadata and target legends are as small as 10px and low-contrast. Mobile navigation lacks a visible network indicator. The actual match uses the deterministic PulseDuelSession and a server-anchored clock, with verified submission and settlement.

Starting-HEAD baseline captures: /private/tmp/chain-duel-audit/before. Its scan had five failure categories covering undersized text, contrast, and generic violet/glow styling. The oversized first mobile screen is the principal usability issue. Earlier redesign captures also remain in /private/tmp/chain-duel-redesign/before.

## Keep list

- Existing brand emblem, original lockup, name, theme choices, soundtrack and sound controls.
- Every existing route, supported wallet and authentication provider.
- Session, onboarding, external/managed wallet and disconnect behavior.
- Online queue, entry selection, demo toggle and matching.
- Private duels, player challenges, invitation codes/links and QR sharing.
- VEX-7, practice preview, original game rules, target schedule and score verification.
- Actual countdown, opponent progress, escrow, settlement, rewards and result authority.
- Player directory, leaderboard, profile, dashboard, settings, wallet, transactions and admin treasury.
- All API endpoints, database schema, environment variables and smart contracts.

Presentation to replace: tall hero composition, repetitive homepage promotional sections, low-contrast metadata, generic glyph icons, oversized mobile spacing and nested glass panels. No business feature is removed; theme choice remains in navigation and settings.

## Exploration

1. **Arena glass:** Chain Duel is a playable window into a midnight orbital arena. Image ground, original metallic brand, cyan action, glass top navigation, two-column desktop composition, compact phone composition, orbital line motion around the actual practice field.
2. **Score console:** Chain Duel is an electronic sports timing console. Dark graphite ground, precise monospaced display, gold signal, product data as the image, score-first split shell, segmented progress motion.
3. **Arcade cabinet:** Chain Duel is a tactile competitive arcade controller. Cool light ground, compact grotesque display, red action, geometric control illustration, centred cabinet shell and pressed spring motion.

Three first-screen explorations are rendered at 390 and 1440px before implementation. Arena glass wins because the user's own cosmic artwork and brand are specific to this product. Score console is useful for the actual match HUD but too austere for discovery. Arcade cabinet is readable but the light ground contradicts the requested midnight world. The implemented direction combines Arena glass with Score console's compact readouts.

The current brand's blue and the user's chosen image ground are intentional continuity. This is a brand evolution, so the history-difference requirement does not override the supplied direction. The category default being avoided is a crypto dashboard with giant KPI cards, fake live counters, a purple launch gradient and repeated marketing cards.

## Tokens

- Ground #040914: the shadowed floor in the supplied arena scene.
- Raised ground #091425; panels use a solid, translucent midnight surface with a fine blue-white border.
- Primary cyan #64e6ff: the playable blue target and arena beam. Gold #f5cf84 identifies the opponent and bonus targets. Red remains the existing negative-target/error semantic. Purple appears in the supplied scene and the existing optional Void theme.
- Primary text #f1f6ff, secondary #b5c3d9, metadata #92a5bf. Metadata must remain readable on an opaque scrim.
- Barlow for UI: condensed enough for player names and wallet controls, with open numerals and a sports interface character. Chakra Petch for headings and readouts: squared construction echoes the existing blade emblem. Locally hosted, licensed font files, metric-adjusted by next/font/local.
- Type scale: 12px metadata, 14px body, 16px emphasis, 20px component heading, 26–36px page heading, 30–44px scores. No marketing-sized phone headings.
- Spacing: 4, 8, 12, 16, 20, 24, 32, 48px. Phone margin 12/16px; desktop content maximum 1320px. Related values stay close; 24–40px separates sections.
- Radius family: 8px small controls, 12px list/stat surfaces, 16/20px main arena and dialogs; pills only for status or floating navigation.
- Blur belongs to navigation and modal layers. Game content uses inexpensive opaque surfaces and scene lighting. No full-page scaling or CSS zoom.

## Shell and density

Desktop: compact glass top navigation, six existing destinations, truthful network indicator, theme/sound and real account controls. Homepage: two-column arena hero, compact entry strip, opponent-mode links, actual player discovery and leaderboard, short game-flow explanation.

Phone: 60–64px header; a small season line and horizontal arrangement of the original emblem/wordmark; concise headline and explanation; two 44–48px actions; three compact values; a 160–200px practice field. Four primary destinations stay in a safe-area-aware bottom bar. All six destinations, theme, sound, account and wallet remain accessible in the menu. The bottom bar is hidden on the match route so gameplay owns the viewport.

Actual match: compact player/clock/opponent strip, real progress and combo state, actual entry/pool information, a container-sized target field. Existing ResizeObserver and event coordinates are retained. No game rules, timings or transaction parameters change.

## Signature

The practice arena is the signature: orbital lines sit below the actual blue, gold and red tappable targets. A hit immediately changes the real local preview score and produces a restrained ripple. Background rings move slowly (16–24 seconds), only while the field is visible and the tab is active. Reduced motion keeps the complete still arena and immediate score feedback. Real match targets preserve timing and input responsiveness.

## Content

Hero: "Stellar Testnet · Season 0" (network label comes from application configuration; Season 0 is the existing launch season), existing Chain Duel brand, "Compete. React. Duel.", "A 60-second, skill-based 1v1 arcade duel. Same targets. Highest verified score wins." Actions: "Enter the arena", "How it works".

Entry strip: duration from PULSE_DUEL, default entry and two-sided pool from ECONOMY. No hardcoded account balances. Practice: "Practice preview", "No stake", actual local Combo and Score. Target legend uses configured blue/gold/red points.

Modes: "Play online" / "Find a matched opponent"; "Duel a friend" / "Create and share a private invitation"; "Face VEX-7" / "Play the computer opponent". All links retain their existing routes and authentication gates.

Discovery: "Find your next rival" and "Leaderboard" use existing public API responses. Loading is a compact skeleton, empty states explain there are no visible players/ranked duels, errors offer retry. No sample users or fabricated live status.

Flow: "Pick your opponent", "Lock your entry", "React. Then settle." Copy describes the real escrow and verification flow. Footer retains rules, how-to-play, legal links and the existing Testnet value disclosure.

Supporting screens retain their actual text, data and controls, with compact page headings, shared controls and responsive rows. Authentication preserves all provider availability, loading, error and install states. Match results show only server-settled outcomes and actual confirmed transaction links.

## Verification plan

Requested viewports: 320×700, 375×812, 390×844, 430×932, 768×1024, 1440×900 and 1920×1080. Capture and inspect homepage, auth/menu, supporting routes and actual demo match states. Exercise real local demo onboarding, private invite/join, online queue/cancel, computer duel, target input, settlement/results and account/disconnect. Use an isolated local SQLite database for browser QA. Run typecheck, lint, existing tests and production build; inspect unchanged business files before shipping. Run the design scan, platform matrix, motion filmstrip and two rounds of independent critique. Report native wallet/real device verification limits accurately.
