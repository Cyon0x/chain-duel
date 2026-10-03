import Link from "next/link";
import clsx from "clsx";
import { Avatar, Badge, EmptyState, Panel } from "@/components/ui";
import { leaderboard } from "@/lib/services/profile";

export const dynamic = "force-dynamic";

export default async function LeaderboardPage() {
  const rows = await leaderboard({ limit: 50 });

  return (
    <div className="flex flex-col gap-6 pt-2">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Global ranking</p>
          <h1 className="text-display mt-2 text-4xl">Leaderboard</h1>
          <p className="mt-2 text-sm text-muted">
            Ranked by Duel Rating. Computer matches are excluded — only human duels move your rating.
          </p>
        </div>
        <Badge tone="accent">Season 0</Badge>
      </header>

      {rows.length ? (
        <Panel className="overflow-hidden p-0">
          <div className="hidden grid-cols-[64px_1.6fr_repeat(5,minmax(0,1fr))] gap-2 border-b border-line px-5 py-3 text-[11px] uppercase tracking-[0.14em] text-dim lg:grid">
            <span>Rank</span>
            <span>Player</span>
            <span className="text-right">Rating</span>
            <span className="text-right">Wins</span>
            <span className="text-right">Losses</span>
            <span className="text-right">Win rate</span>
            <span className="text-right">Streak</span>
          </div>
          <ol>
            {rows.map((row) => {
              const winRate = row.games_played ? Math.round((row.wins / row.games_played) * 100) : 0;
              const podium = row.position <= 3;
              return (
                <li key={row.user_id} className="border-b border-line last:border-0">
                  <Link
                    href={`/players/${row.username}`}
                    className="focus-ring grid grid-cols-[44px_1fr_auto] items-center gap-3 px-5 py-3.5 transition-colors hover:bg-surface lg:grid-cols-[64px_1.6fr_repeat(5,minmax(0,1fr))]"
                  >
                    <span
                      className={clsx(
                        "numeric text-sm font-semibold",
                        podium ? "text-accent" : "text-muted",
                      )}
                    >
                      #{row.position}
                    </span>
                    <span className="flex min-w-0 items-center gap-3">
                      <Avatar name={row.username} src={row.avatar} size={34} theme={row.theme} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{row.username}</span>
                        <span className="block text-[11px] text-dim lg:hidden">
                          {row.rating} rating · {row.wins}W {row.losses}L
                        </span>
                      </span>
                    </span>
                    <span className="numeric text-right text-sm font-semibold text-accent">{row.rating}</span>
                    <span className="numeric hidden text-right text-sm lg:block">{row.wins}</span>
                    <span className="numeric hidden text-right text-sm lg:block">{row.losses}</span>
                    <span className="numeric hidden text-right text-sm lg:block">{winRate}%</span>
                    <span className="numeric hidden text-right text-sm lg:block">
                      {row.current_streak > 0 ? `${row.current_streak}🔥` : row.current_streak}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ol>
        </Panel>
      ) : (
        <EmptyState
          icon="◈"
          title="No ranked results yet"
          description="The leaderboard fills up as duelists complete human-vs-human matches."
        />
      )}

      <p className="text-center text-xs text-dim">
        Reputation is tracked separately from rating and reflects completed duels, cancellations and fair play.
      </p>
    </div>
  );
}
