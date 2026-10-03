import { Panel } from "@/components/ui";
import { PULSE_DUEL } from "@/lib/config/game";

export const metadata = { title: "Game Rules — Chain Duel" };

export default function RulesPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 pt-2">
      <header>
        <p className="eyebrow">Competitive integrity</p>
        <h1 className="text-display mt-2 text-4xl">Game rules</h1>
      </header>
      <Panel className="flex flex-col gap-5 px-6 py-6 text-sm leading-relaxed text-muted">
        <section>
          <h2 className="text-base font-semibold text-ink">1. The duel</h2>
          <p className="mt-2">
            A Pulse Duel lasts {PULSE_DUEL.durationMs / 1000} seconds. Both players receive an identical, deterministic
            target sequence derived from the match seed. The player with the higher verified score wins. If scores and
            maximum combos are identical, the lower seat wins.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink">2. Scoring</h2>
          <p className="mt-2">
            Blue +10, gold +25, red −15. Combos start at 3 hits (1.2×), 5 hits (1.5×) and 8 hits (2×). Scores are never
            negative. A miss or a red target resets the combo.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink">3. Fair play</h2>
          <p className="mt-2">
            Clients submit an event log, not a score. The server replays the log against the shared schedule and rejects
            submissions with unknown targets, duplicate hits, hits faster than humanly plausible (~70 ms), events after
            the match end, or scores above the theoretical maximum.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink">4. Escrow and settlement</h2>
          <p className="mt-2">
            Both entries are locked in the Chain Duel escrow contract before the duel begins. On settlement the contract
            pays the winner and retains the protocol fee in basis points. Settlement is idempotent: a match can be settled
            at most once.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink">5. Abandonment</h2>
          <p className="mt-2">
            If a player disconnects or never submits, the match settles after a grace period using the verified results
            that did arrive. A disconnect is not an automatic win for either side; the verified score decides.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink">6. Cancellation and refunds</h2>
          <p className="mt-2">
            A private duel that nobody joins expires after its join window. The creator can cancel the duel and reclaim
            the full entry. Cancelled and expired duels never enter settlement.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink">7. Rating and reputation</h2>
          <p className="mt-2">
            Only human-vs-human duels affect Duel Rating (an Elo system starting at 1000). Computer duels are unrated.
            Reputation is separate and reflects completed duels, cancellations and fair play.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink">8. Testnet</h2>
          <p className="mt-2">
            Chain Duel runs on Stellar Testnet. Testnet assets have no real-world value and the protocol makes no
            guarantee of value, uptime or finality beyond what the Testnet provides.
          </p>
        </section>
      </Panel>
    </div>
  );
}
