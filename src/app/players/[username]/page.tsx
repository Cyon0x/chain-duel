import Link from "next/link";
import { notFound } from "next/navigation";
import { Avatar, Badge, EmptyState, Panel, SectionHeader, Stat } from "@/components/ui";
import { MatchRowItem } from "@/components/lists";
import { ChallengeSection } from "@/components/play/challenge-section";
import { getSessionUser } from "@/lib/auth/session";
import { publicProfile } from "@/lib/services/profile";
import { ECONOMY, TREASURY_LIMITS, formatXlm } from "@/lib/config/game";
import { truncateAddress } from "@/lib/explorer";

export const dynamic = "force-dynamic";

export default async function PlayerProfilePage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  const session = await getSessionUser();
  const data = await publicProfile(username, session?.user.id ?? null);
  if (!data) notFound();

  const profile = data.profile;
  const winRate = profile.games_played ? Math.round((profile.wins / profile.games_played) * 100) : 0;

  return (
    <div className="flex flex-col gap-6 pt-2">
      <Link href="/players" className="focus-ring w-fit text-sm text-muted hover:text-ink">
        ← Players
      </Link>

      <Panel className="flex flex-col gap-6 px-5 py-6 sm:px-7">
        <div className="flex flex-wrap items-center gap-5">
          <Avatar name={profile.username} src={profile.avatar} size={72} theme={profile.theme} />
          <div className="min-w-0 flex-1">
            <h1 className="text-display text-3xl">{profile.username}</h1>
            <p className="numeric mt-1 text-sm text-muted">
              {data.walletAddress ? truncateAddress(data.walletAddress, 5) : "managed wallet"} · Rank #{data.rank}
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <Badge tone="accent">{profile.rating} rating</Badge>
            <span className="text-xs text-dim">Reputation {profile.reputation}</span>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Wins" value={profile.wins} tone="success" />
          <Stat label="Losses" value={profile.losses} />
          <Stat label="Win rate" value={`${winRate}%`} />
          <Stat label="Streak" value={profile.current_streak} hint={`Best ${profile.best_streak}`} />
          <Stat label="Duels" value={profile.games_played} hint={`${profile.human_games} vs humans`} />
        </div>
      </Panel>

      {data.isSelf ? (
        <Panel className="px-5 py-4 text-sm text-muted">
          This is your public profile.{" "}
          <Link href="/profile" className="text-accent hover:underline">
            Open your dashboard →
          </Link>
        </Panel>
      ) : session ? (
        <ChallengeSection
          username={profile.username}
          options={[
            { xlm: 2, label: "Casual" },
            { xlm: 5, label: "Standard" },
            { xlm: 10, label: "High stakes" },
          ]}
          defaultEntry={ECONOMY.defaultEntryStroops / 10_000_000}
          demoAllowed
          maxEntryXlm={TREASURY_LIMITS.maxBotEntryStroops / 10_000_000}
        />
      ) : (
        <Panel className="flex items-center justify-between gap-4 px-5 py-4">
          <p className="text-sm text-muted">Sign in to challenge {profile.username}.</p>
          <Link href="/login" className="focus-ring text-sm font-medium text-accent hover:underline">
            Sign in →
          </Link>
        </Panel>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <SectionHeader title="Recent duels" />
          {data.matches.length ? (
            <div className="flex flex-col gap-2">
              {data.matches.slice(0, 8).map((match) => (
                <MatchRowItem key={match.id} match={match} />
              ))}
            </div>
          ) : (
            <EmptyState icon="◆" title="No duels yet" description={`${profile.username} has not played a duel yet.`} />
          )}
        </section>

        <section>
          <SectionHeader title="Achievements" />
          <Panel className="grid grid-cols-2 gap-2 px-4 py-4">
            {data.achievements.map((achievement) => (
              <div
                key={achievement.code}
                className={`flex items-center gap-2 rounded-xl px-2.5 py-2 text-xs ${
                  achievement.unlocked ? "bg-accent-soft text-ink" : "text-dim opacity-45"
                }`}
              >
                <span aria-hidden className="text-accent">
                  {achievement.icon}
                </span>
                <span className="truncate">{achievement.name}</span>
              </div>
            ))}
          </Panel>
          <p className="mt-3 text-xs text-dim">
            Total earned {formatXlm(profile.total_earned_stroops)} XLM · wagered {formatXlm(profile.total_wagered_stroops)} XLM
          </p>
        </section>
      </div>
    </div>
  );
}
