import Link from "next/link";
import { ButtonLink, EmptyState, Input } from "@/components/ui";
import { PlayerCard } from "@/components/lists";
import { getSessionUser } from "@/lib/auth/session";
import { directory } from "@/lib/services/profile";

export const dynamic = "force-dynamic";

export default async function PlayersPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string }>;
}) {
  const { search } = await searchParams;
  const session = await getSessionUser();
  const players = await directory({
    search: search?.trim() || undefined,
    limit: 36,
    viewerId: session?.user.id ?? null,
  });

  return (
    <div className="flex flex-col gap-6 pt-2">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Player directory</p>
          <h1 className="text-display mt-2 text-4xl">Players</h1>
          <p className="mt-2 text-sm text-muted">Search duelists, check their form, and send a challenge.</p>
        </div>
        <form className="flex w-full max-w-sm gap-2" action="/players" role="search">
          <Input name="search" defaultValue={search ?? ""} placeholder="Search by username" aria-label="Search players" />
          <button
            type="submit"
            className="focus-ring h-11 shrink-0 rounded-2xl border border-line-strong bg-surface-strong px-4 text-sm font-semibold transition-colors hover:border-accent"
          >
            Search
          </button>
        </form>
      </header>

      {players.length ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {players.map((player) => (
            <PlayerCard key={player.user_id} player={player} />
          ))}
        </div>
      ) : (
        <EmptyState
          icon="◇"
          title={search ? "No players found" : "No players yet"}
          description={search ? `Nobody matches “${search}”. Try another name.` : "Be the first duelist to complete a profile."}
          action={<ButtonLink href="/play">Play a duel</ButtonLink>}
        />
      )}

      <p className="text-center text-xs text-dim">
        Online status is only shown when Chain Duel can verify it. <Link href="/leaderboard" className="text-accent hover:underline">See the leaderboard →</Link>
      </p>
    </div>
  );
}
