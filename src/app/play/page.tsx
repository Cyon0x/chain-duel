import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, EmptyState, Panel, SectionHeader } from "@/components/ui";
import { getSessionUser } from "@/lib/auth/session";
import { dashboardFor } from "@/lib/services/profile";
import { formatXlm } from "@/lib/config/game";
import { MatchRowItem } from "@/components/lists";

export const dynamic = "force-dynamic";

const MODES = [
  {
    href: "/play/online",
    tag: "Live queue",
    title: "Play online",
    body: "Get matched with another duelist at your entry. Same targets, same clock.",
    glyph: "◈",
    accent: true,
  },
  {
    href: "/play/friend",
    tag: "Private",
    title: "Play with a friend",
    body: "Create a private duel and send a single link. Expires in 30 minutes.",
    glyph: "⟁",
  },
  {
    href: "/play/computer",
    tag: "Vs computer",
    title: "Vs computer",
    body: "Face VEX-7, the Chain Duel computer. It plays the real game engine.",
    glyph: "⌘",
  },
];

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
            Pulse Duel is sixty seconds of targets and combos. Pick an opponent type and we handle escrow, verification
            and settlement.
          </p>
        </div>
        <div className="panel-flat px-4 py-3 text-right">
          <p className="eyebrow">Default entry</p>
          <p className="numeric mt-1.5 text-xl font-semibold text-accent">
            {formatXlm(5 * 10_000_000)} <span className="text-sm text-dim">XLM</span>
          </p>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-3">
        {MODES.map((mode) => (
          <Link key={mode.href} href={mode.href} className="focus-ring group rounded-[18px]">
            <Panel
              className={`flex h-full flex-col gap-4 px-5 py-6 transition-colors ${
                mode.accent ? "border-accent/40" : "group-hover:border-accent/40"
              }`}
            >
              <span aria-hidden className="text-2xl text-accent">
                {mode.glyph}
              </span>
              <div>
                <Badge tone={mode.accent ? "accent" : "neutral"}>{mode.tag}</Badge>
                <h2 className="text-display mt-3 text-2xl">{mode.title}</h2>
                <p className="mt-2 text-sm text-muted">{mode.body}</p>
              </div>
              <span className="mt-auto text-sm font-medium text-accent">
                {mode.accent ? "Find a match" : "Open"} <span aria-hidden>→</span>
              </span>
            </Panel>
          </Link>
        ))}
      </div>

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
