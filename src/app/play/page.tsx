import Link from "next/link";
import { redirect } from "next/navigation";
import { EmptyState, Panel, SectionHeader } from "@/components/ui";
import { DuelModeLinks } from "@/components/play/mode-links";
import { Icon } from "@/components/icons";
import { getSessionUser } from "@/lib/auth/session";
import { dashboardFor } from "@/lib/services/profile";
import { ECONOMY, formatXlm } from "@/lib/config/game";
import { MatchRowItem } from "@/components/lists";

export const dynamic = "force-dynamic";

export default async function PlayPage() {
  const session = await getSessionUser();
  if (!session) redirect("/login");
  if (session.profile?.onboarding_complete !== 1) redirect("/onboarding");

  const data = await dashboardFor(session);

  return (
    <div className="flex flex-col gap-8 pt-2">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Play hub</p>
          <h1 className="text-display mt-2 text-4xl sm:text-5xl">Choose your duel</h1>
          <p className="mt-3 max-w-lg text-sm text-muted">
            Sixty seconds of targets and combos. Pick your opponent and entry. Highest verified score wins.
          </p>
        </div>
        <div className="inline-flex items-center gap-2 text-sm text-muted">
          <Icon name="layers" size={16} />Default entry <span className="numeric text-accent">{formatXlm(ECONOMY.defaultEntryStroops)} XLM</span>
        </div>
      </header>

      <DuelModeLinks />

      {data.activeGames.length > 0 ? (
        <section>
          <SectionHeader title="Resume" subtitle="These duels are still open." />
          <div className="grid gap-3 sm:grid-cols-2">
            {data.activeGames.map((game) => (
              <Panel key={game.id} className="flex items-center justify-between gap-3 px-4 py-3.5">
                <div>
                  <p className="text-sm font-medium capitalize">{game.mode === "bot" ? "Computer duel" : "Duel"} · {game.status}</p>
                  <p className="numeric mt-1 text-xs text-dim">
                    {game.demo ? "Demo" : `${formatXlm(game.entry_stroops)} XLM`}
                  </p>
                </div>
                <Link href={`/match/${game.id}`} className="focus-ring text-sm font-medium text-accent">
                  Resume →
                </Link>
              </Panel>
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <SectionHeader
          title="Your recent form"
          action={
            <Link href="/profile" className="focus-ring text-sm text-accent hover:underline">
              Full profile
            </Link>
          }
        />
        {data.recentMatches.length ? (
          <div className="flex flex-col gap-2">
            {data.recentMatches.slice(0, 4).map((match) => (
              <MatchRowItem key={match.id} match={match} />
            ))}
          </div>
        ) : (
          <EmptyState icon="◆" title="No duels yet" description="Play your first match to start a streak." />
        )}
      </section>
    </div>
  );
}
