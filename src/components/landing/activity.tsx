"use client";

import Link from "next/link";
import { Avatar, Button, SkeletonRows } from "@/components/ui";
import { Icon } from "@/components/icons";
import { MatchRowItem, ActiveDuelCard } from "@/components/lists";
import { useSession } from "@/components/providers";
import { api } from "@/lib/api/client";
import { formatXlm } from "@/lib/config/game";
import { useAsync } from "@/lib/hooks/use-async";
import type { DirectoryPlayer, GameViewRow, MatchRowView } from "@/lib/api/views";

type RankedPlayer = DirectoryPlayer & { position: number };

/** Only render activity the existing services actually return. */
export function LandingDuels() {
  const session = useSession();
  const open = useAsync<{ games: GameViewRow[] }>(async () => {
    const response = await api<{ games: GameViewRow[] }>("/api/duels");
    const now = Date.now();
    return { games: response.games.filter((game) => new Date(game.expires_at).getTime() > now) };
  }, [], { pollMs: 30_000 });
  const own = useAsync<{ activeGames: GameViewRow[]; recentMatches: MatchRowView[] }>(() => api("/api/profile"), [], { enabled: session.authenticated });
  const available = (open.data?.games ?? []).filter((game) => game.creator_id !== session.userId).slice(0, 3);
  const active = own.data?.activeGames.slice(0, 2) ?? [];
  const recent = own.data?.recentMatches.slice(0, 3) ?? [];
  if (!available.length && !active.length && !recent.length && !own.error) return null;
  return <section aria-labelledby="duel-activity-heading" className="flex flex-col gap-3">
    <div className="activity-panel__header"><h2 id="duel-activity-heading">Your arena</h2><Link href="/play" className="focus-ring">Play hub <Icon name="arrow" size={15} /></Link></div>
    {active.map((game) => <ActiveDuelCard key={game.id} game={game} />)}
    {available.length ? <div className="grid gap-2 sm:grid-cols-3">{available.map((game) => <Link key={game.id} href={`/duel/${game.code}`} className="focus-ring panel-flat flex flex-wrap items-center justify-between gap-2 px-4 py-3"><span><strong className="block text-sm">Open duel · {game.code}</strong><span className="text-xs text-muted">{game.demo ? "Demo · no stake" : `${formatXlm(game.entry_stroops)} XLM entry · ${formatXlm(game.entry_stroops * 2)} XLM pool`}</span></span><span className="inline-flex min-h-8 items-center gap-2 text-sm text-accent">Join <Icon name="arrow" size={14} /></span></Link>)}</div> : null}
    {recent.length ? <div><h3 className="mb-2 text-sm text-muted">Recent duels</h3><div className="flex flex-col gap-2">{recent.map((match) => <MatchRowItem key={match.id} match={match} />)}</div></div> : null}
    {own.error && !own.data ? <ActivityError label="Your duel activity could not be loaded." retry={own.reload} /> : null}
  </section>;
}

/** Existing public APIs, with honest loading, empty and retry states. */
export function LandingActivity() {
  const players = useAsync<{ players: DirectoryPlayer[] }>(() => api("/api/players?limit=4"), [], { pollMs: 30_000 });
  const ranking = useAsync<{ leaderboard: RankedPlayer[] }>(() => api("/api/leaderboard?limit=4"), [], { pollMs: 30_000 });

  return (
    <div className="landing-activity">
      <section className="activity-panel" aria-labelledby="rivals-heading">
        <div className="activity-panel__header"><h2 id="rivals-heading">Find your next rival</h2><Link href="/players" className="focus-ring">Players <Icon name="arrow" size={15} /></Link></div>
        {!players.data && players.loading ? <><span className="sr-only" role="status">Loading players</span><SkeletonRows rows={3} /></>
          : players.error && !players.data ? <ActivityError label="Players could not be loaded." retry={players.reload} />
          : players.data?.players.length ? <ul className="activity-list">{players.data.players.map((player) => (
            <li key={player.user_id}><Link className="activity-row focus-ring" href={`/players/${player.username}`}><Avatar name={player.username} src={player.avatar} size={32} theme={player.theme} /><span className="activity-row__identity"><strong>{player.username}</strong><span>{player.games_played} duels · {player.wins} wins</span></span><span className="activity-row__rating numeric">{player.rating}<span>Rating</span></span></Link></li>
          ))}</ul>
          : <p className="activity-empty">Player profiles appear here after onboarding. <Link href="/play" className="text-accent focus-ring">Enter the arena</Link> to create yours.</p>}
      </section>
      <section className="activity-panel" aria-labelledby="ranking-heading">
        <div className="activity-panel__header"><h2 id="ranking-heading">Leaderboard</h2><Link href="/leaderboard" className="focus-ring">Full ranking <Icon name="arrow" size={15} /></Link></div>
        {!ranking.data && ranking.loading ? <><span className="sr-only" role="status">Loading leaderboard</span><SkeletonRows rows={3} /></>
          : ranking.error && !ranking.data ? <ActivityError label="The leaderboard could not be loaded." retry={ranking.reload} />
          : ranking.data?.leaderboard.length ? <ol className="activity-list">{ranking.data.leaderboard.map((player) => (
            <li key={player.user_id}><Link className="activity-row focus-ring" href={`/players/${player.username}`}><span className="activity-row__rank numeric">{String(player.position).padStart(2, "0")}</span><span className="activity-row__identity"><strong>{player.username}</strong><span>{player.wins} wins · {player.losses} losses</span></span><span className="activity-row__rating numeric">{player.rating}<span>Rating</span></span></Link></li>
          ))}</ol>
          : <p className="activity-empty">The ranking starts with completed human duels. Computer matches are unrated.</p>}
      </section>
    </div>
  );
}

function ActivityError({ label, retry }: { label: string; retry: () => unknown }) {
  return <div className="activity-empty"><p role="status">{label}</p><Button variant="secondary" size="sm" className="mt-3" onClick={() => { void retry(); }}>Try again</Button></div>;
}
