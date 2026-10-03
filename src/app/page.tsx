import Link from "next/link";
import { Badge, ButtonLink, Panel } from "@/components/ui";
import { LandingPreview } from "@/components/landing/preview";
import { THEME_DEFINITIONS, THEMES } from "@/lib/config/themes";
import { PULSE_DUEL, ECONOMY, formatXlm } from "@/lib/config/game";
import { publicStellarConfig } from "@/lib/config/stellar";
import { getSessionUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const MODES = [
  {
    tag: "Live queue",
    title: "Play online",
    body: "Match with another duelist at your entry. Same targets, same clock, first to the top score takes the pool.",
    href: "/play/online",
    glyph: "◈",
  },
  {
    tag: "Private",
    title: "Play with a friend",
    body: "Spin up a private duel and send a single link. Your friend joins in one tap — no searching, no strangers.",
    href: "/play/friend",
    glyph: "⟁",
  },
  {
    tag: "Vs computer",
    title: "Play vs computer",
    body: "The Chain Duel computer is a real opponent that reacts to the same target stream. Warm up or grind a session.",
    href: "/play/computer",
    glyph: "⌘",
  },
];

const STEPS = [
  { n: "01", title: "Sign in", body: "Connect Freighter or continue with a managed Chain Duel wallet." },
  { n: "02", title: "Pick a mode", body: "Online, private invite, or against the computer." },
  { n: "03", title: "Enter the duel", body: "Your entry is escrowed on Stellar. Nothing moves until the match is settled." },
  { n: "04", title: "React and combo", body: "Sixty seconds of targets. Chain hits to stack a multiplier up to 2×." },
  { n: "05", title: "Settle", body: "The server replays both event logs and the winner is paid on-chain automatically." },
];

export default async function LandingPage() {
  const session = await getSessionUser();
  const network = publicStellarConfig();
  const entry = formatXlm(ECONOMY.defaultEntryStroops);
  const pool = formatXlm(ECONOMY.defaultEntryStroops * 2);

  return (
    <div className="flex flex-col gap-24 pb-10 sm:gap-28">
      <section className="grid items-center gap-10 pt-6 lg:grid-cols-[1.05fr_1fr] lg:gap-14">
        <div className="animate-rise">
          <Badge tone="accent">Stellar {network.isTestnet ? "Testnet" : "Mainnet"} · Season 0</Badge>
          <h1 className="text-display mt-5 text-[clamp(3rem,10vw,5.25rem)]">
            CHAIN
            <br />
            <span className="text-accent">DUEL</span>
          </h1>
          <p className="mt-5 max-w-md text-lg text-muted">
            Compete. React. Duel. A skill-based 1v1 arcade game where the match is off-chain and the payout is real —
            escrowed and settled on Stellar.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <ButtonLink href={session ? "/play" : "/login"} size="lg">
              Play now
            </ButtonLink>
            <ButtonLink href="/how-to-play" size="lg" variant="secondary">
              How it works
            </ButtonLink>
          </div>
          <dl className="mt-10 grid max-w-lg grid-cols-3 gap-3">
            {[
              { label: "Duel length", value: `${PULSE_DUEL.durationMs / 1000}s` },
              { label: "Default entry", value: `${entry} XLM` },
              { label: "Prize pool", value: `${pool} XLM` },
            ].map((stat) => (
              <div key={stat.label} className="panel-flat px-3.5 py-3">
                <dt className="eyebrow">{stat.label}</dt>
                <dd className="numeric mt-1.5 text-lg font-semibold">{stat.value}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="animate-rise">
          <LandingPreview />
        </div>
      </section>

      <section>
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow">Three ways to duel</p>
            <h2 className="text-display mt-2 text-3xl sm:text-4xl">Choose your arena</h2>
          </div>
          <p className="max-w-sm text-sm text-muted">
            Every mode runs the same deterministic game engine. Only the opponent and the stakes change.
          </p>
        </header>
        <div className="grid gap-4 md:grid-cols-3">
          {MODES.map((mode) => (
            <Link key={mode.href} href={mode.href} className="focus-ring group rounded-[18px]">
              <Panel className="flex h-full flex-col gap-3 transition-colors group-hover:border-accent/45">
                <span aria-hidden className="text-xl text-accent">
                  {mode.glyph}
                </span>
                <span className="eyebrow">{mode.tag}</span>
                <h3 className="text-lg font-semibold tracking-tight">{mode.title}</h3>
                <p className="text-sm text-muted">{mode.body}</p>
                <span className="mt-auto pt-2 text-sm font-medium text-accent">
                  Enter <span aria-hidden>→</span>
                </span>
              </Panel>
            </Link>
          ))}
        </div>
      </section>

      <section className="grid gap-8 lg:grid-cols-[1fr_1.1fr]">
        <div>
          <p className="eyebrow">Match flow</p>
          <h2 className="text-display mt-2 text-3xl sm:text-4xl">
            From sign-in to
            <br />
            settlement
          </h2>
          <p className="mt-4 max-w-md text-sm text-muted">
            Chain Duel keeps the fast part fast. Reactions stay in your browser at 60fps; the money side is escrowed,
            verified and settled on Stellar Testnet.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            <Badge tone="success">Server-verified results</Badge>
            <Badge tone="neutral">Deterministic targets</Badge>
            <Badge tone="gold">10% protocol fee</Badge>
          </div>
        </div>
        <ol className="flex flex-col gap-3">
          {STEPS.map((step) => (
            <li key={step.n} className="panel-flat flex items-start gap-4 px-4 py-3.5">
              <span className="numeric text-sm text-accent">{step.n}</span>
              <div>
                <p className="text-sm font-semibold tracking-tight">{step.title}</p>
                <p className="mt-0.5 text-sm text-muted">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="panel grid gap-8 px-6 py-10 sm:px-10 lg:grid-cols-2 lg:items-center">
        <div>
          <p className="eyebrow">Built on Stellar</p>
          <h2 className="text-display mt-2 text-3xl sm:text-4xl">
            Escrow you can
            <br />
            verify yourself
          </h2>
          <p className="mt-4 max-w-md text-sm text-muted">
            Each duel is a Soroban contract on {network.label}. Both entries are locked before the countdown, the winner
            is paid from the pool, and the protocol fee is taken in basis points. Settlement is idempotent, so a retry
            can never pay twice.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <ButtonLink href="/transactions" variant="secondary">
              See transactions
            </ButtonLink>
            <ButtonLink href="/rules" variant="ghost">
              Game rules
            </ButtonLink>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {[
            { label: "Entry locked", value: `${entry} XLM`, hint: "Escrowed on create" },
            { label: "Prize pool", value: `${pool} XLM`, hint: "Both entries" },
            { label: "Winner reward", value: "9.00 XLM", hint: "Pool minus fee" },
            { label: "Protocol fee", value: "1.00 XLM", hint: "1000 bps" },
          ].map((item) => (
            <div key={item.label} className="panel-flat px-4 py-3.5">
              <p className="eyebrow">{item.label}</p>
              <p className="numeric mt-2 text-xl font-semibold text-accent">{item.value}</p>
              <p className="mt-1 text-xs text-dim">{item.hint}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <header className="mb-6">
          <p className="eyebrow">Four environments</p>
          <h2 className="text-display mt-2 text-3xl sm:text-4xl">Pick your look</h2>
        </header>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {THEMES.map((id) => {
            const theme = THEME_DEFINITIONS[id];
            return (
              <div
                key={id}
                className="panel-flat relative overflow-hidden px-4 py-5"
                style={{ background: `linear-gradient(160deg, ${theme.accentSoft}, transparent 65%)` }}
              >
                <span aria-hidden className="block h-8 w-8 rounded-full" style={{ background: theme.accent }} />
                <p className="mt-4 text-sm font-semibold">{theme.name}</p>
                <p className="mt-1 text-xs text-muted">{theme.tagline}</p>
              </div>
            );
          })}
        </div>
      </section>

      <section className="panel relative overflow-hidden px-6 py-12 text-center sm:px-10">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-40 h-72 opacity-60"
          style={{ background: "radial-gradient(50% 100% at 50% 100%, var(--accent-soft), transparent 70%)" }}
        />
        <p className="eyebrow">Ready when you are</p>
        <h2 className="text-display mt-3 text-4xl sm:text-5xl">Enter the duel</h2>
        <p className="mx-auto mt-4 max-w-md text-sm text-muted">
          Connect a wallet in seconds, or try a no-stake demo duel to learn the rhythm first.
        </p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <ButtonLink href={session ? "/play" : "/login"} size="lg">
            Play now
          </ButtonLink>
          <ButtonLink href="/login" size="lg" variant="secondary">
            Try demo mode
          </ButtonLink>
        </div>
      </section>
    </div>
  );
}
