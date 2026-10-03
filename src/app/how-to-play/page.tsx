import { Badge, ButtonLink, Panel, SectionHeader } from "@/components/ui";
import { PULSE_DUEL, ECONOMY, formatXlm } from "@/lib/config/game";

export const metadata = { title: "How to Play — Chain Duel" };

const STEPS = [
  { n: "01", title: "Connect", body: "Sign in with Freighter (or a managed Chain Duel wallet) and set a username." },
  { n: "02", title: "Choose a mode", body: "Play online, create a private invite, or take on the computer." },
  { n: "03", title: "Enter the duel", body: "Your entry is escrowed on Stellar. Nothing moves until settlement." },
  { n: "04", title: "Hit targets", body: "Blue is +10, gold is +25, red is −15. Red also breaks your combo." },
  { n: "05", title: "Build combos", body: "Chain hits to raise your multiplier — up to 2× at eight in a row." },
  { n: "06", title: "Finish the match", body: "60 seconds. Both players share the exact same target stream." },
  { n: "07", title: "Settlement", body: "The server replays both event logs; the winner is paid on-chain." },
  { n: "08", title: "Track results", body: "Rating, reputation, history and transactions all update from the verified result." },
];

export default function HowToPlayPage() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-10 pt-2">
      <header>
        <p className="eyebrow">Guide</p>
        <h1 className="text-display mt-2 text-4xl sm:text-5xl">How to play</h1>
        <p className="mt-4 max-w-2xl text-muted">
          Chain Duel is a reaction game. Two players get the same targets for sixty seconds and the higher verified
          score takes the pool. No hidden dice, no client-trusted scores.
        </p>
      </header>

      <section>
        <SectionHeader title="The loop" subtitle="Eight steps from sign-in to settlement." />
        <ol className="grid gap-3 sm:grid-cols-2">
          {STEPS.map((step) => (
            <li key={step.n} className="panel-flat flex items-start gap-4 px-4 py-3.5">
              <span className="numeric text-sm text-accent">{step.n}</span>
              <div>
                <p className="text-sm font-semibold">{step.title}</p>
                <p className="mt-0.5 text-sm text-muted">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        {PULSE_DUEL.targets.map((target) => (
          <Panel key={target.kind} className="flex items-center gap-4 px-5 py-4">
            <span aria-hidden className={`target target--${target.kind} relative !left-0 !top-0 h-10 w-10 shrink-0`}>
              <span className="target__core" />
            </span>
            <div>
              <p className="text-sm font-semibold capitalize">{target.kind} target</p>
              <p className="numeric mt-0.5 text-sm text-muted">
                {target.points > 0 ? "+" : ""}
                {target.points} points
              </p>
            </div>
          </Panel>
        ))}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Panel className="px-5 py-5">
          <p className="eyebrow">Combo multipliers</p>
          <ul className="mt-3 flex flex-col gap-2 text-sm">
            {PULSE_DUEL.combos.map((tier) => (
              <li key={tier.hits} className="flex items-center justify-between border-b border-line pb-2 last:border-0">
                <span className="text-muted">{tier.hits} hits in a row</span>
                <span className="numeric text-accent">{tier.multiplier}×</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-dim">
            A miss or a red target resets your combo. Hits inside the combo window keep it alive.
          </p>
        </Panel>
        <Panel className="px-5 py-5">
          <p className="eyebrow">Economy</p>
          <ul className="mt-3 flex flex-col gap-2 text-sm">
            <li className="flex items-center justify-between border-b border-line pb-2">
              <span className="text-muted">Default entry</span>
              <span className="numeric">{formatXlm(ECONOMY.defaultEntryStroops)} XLM each</span>
            </li>
            <li className="flex items-center justify-between border-b border-line pb-2">
              <span className="text-muted">Prize pool</span>
              <span className="numeric">{formatXlm(ECONOMY.defaultEntryStroops * 2)} XLM</span>
            </li>
            <li className="flex items-center justify-between border-b border-line pb-2">
              <span className="text-muted">Winner reward</span>
              <span className="numeric text-success">9.00 XLM</span>
            </li>
            <li className="flex items-center justify-between">
              <span className="text-muted">Protocol fee</span>
              <span className="numeric text-dim">10% · 1000 bps</span>
            </li>
          </ul>
          <p className="mt-3 text-xs text-dim">
            Entries are escrowed in the Chain Duel Soroban contract. Unjoined private duels can be cancelled for a full
            refund after the join window.
          </p>
        </Panel>
      </section>

      <Panel className="flex flex-wrap items-center justify-between gap-4 px-5 py-5">
        <div>
          <p className="eyebrow">Fair play</p>
          <p className="mt-1.5 max-w-xl text-sm text-muted">
            Chain Duel never trusts a client-submitted score. You send your event log, the server replays it against the
            shared deterministic schedule, and impossible results are rejected before any settlement.
          </p>
        </div>
        <div className="flex gap-2">
          <Badge tone="success">Verified results</Badge>
          <ButtonLink href="/play" variant="secondary">
            Play now
          </ButtonLink>
        </div>
      </Panel>
    </div>
  );
}
