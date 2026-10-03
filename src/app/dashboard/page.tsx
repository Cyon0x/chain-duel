import Link from "next/link";
import { redirect } from "next/navigation";
import { Avatar, Badge, ButtonLink, EmptyState, Panel, SectionHeader, Stat } from "@/components/ui";
import { ActiveDuelCard, MatchRowItem, TransactionItem } from "@/components/lists";
import { InviteInbox } from "@/components/invite-inbox";
import { getSessionUser } from "@/lib/auth/session";
import { dashboardFor } from "@/lib/services/profile";
import { formatXlm } from "@/lib/config/game";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await getSessionUser();
  if (!session) redirect("/login");
  if (session.profile?.onboarding_complete !== 1) redirect("/onboarding");

  const data = await dashboardFor(session);
  const profile = data.profile;
  const winRate = profile.games_played ? Math.round((profile.wins / profile.games_played) * 100) : 0;

  return (
    <div className="flex flex-col gap-8 pt-2">
      <Panel className="flex flex-col gap-6 px-5 py-6 sm:px-7">
        <div className="flex flex-wrap items-center gap-5">
          <Avatar name={profile.username} src={profile.avatar} size={64} theme={profile.theme} />
          <div className="min-w-0 flex-1">
            <p className="eyebrow">Duelist</p>
            <h1 className="text-display mt-1 text-3xl">{profile.username}</h1>
            <p className="mt-1 text-sm text-muted">
              Rank #{data.rank} · {data.wallet ? shortWallet(data.wallet.address) : "managed wallet"}
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <Badge tone="accent">{profile.rating} rating</Badge>
            <span className="text-xs text-dim">Reputation {profile.reputation}</span>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="panel-flat px-4 py-3.5">
            <p className="eyebrow">XLM balance</p>
            <p className="numeric mt-2 text-2xl font-semibold text-accent">
              {data.balanceXlm ?? "—"}
              <span className="ml-1 text-sm text-dim">XLM</span>
            </p>
            <p className="mt-1 text-xs text-dim">Native Testnet balance</p>
          </div>
          <Stat label="Record" value={`${profile.wins}W · ${profile.losses}L`} hint={`${winRate}% win rate`} />
          <Stat
            label="Streak"
            value={profile.current_streak}
            hint={`Best ${profile.best_streak}`}
            tone={profile.current_streak > 0 ? "success" : "default"}
          />
          <Stat label="Duels played" value={profile.games_played} hint={`${profile.bot_games} vs computer`} />
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <ButtonLink href="/play/online" size="lg">
            Play online
          </ButtonLink>
          <ButtonLink href="/play/friend" size="lg" variant="secondary">
            Play with friend
          </ButtonLink>
          <ButtonLink href="/play/computer" size="lg" variant="secondary">
            Vs computer
          </ButtonLink>
        </div>
        {!data.escrowAvailable ? (
          <p className="rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
            On-chain escrow is not configured on this deployment. Demo duels are fully playable; staked duels activate as
            soon as the Soroban contract is connected.
          </p>
        ) : null}
      </Panel>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="flex flex-col gap-6">
          <InviteInbox />

          {data.activeGames.length > 0 ? (
            <section>
              <SectionHeader title="In progress" subtitle="Jump back into a duel that is still running." />
              <div className="flex flex-col gap-2">
                {data.activeGames.map((game) => (
                  <ActiveDuelCard key={game.id} game={game} />
                ))}
              </div>
            </section>
          ) : null}

          <section>
            <SectionHeader
              title="Recent duels"
              subtitle="Your last six matches."
              action={
                <Link href="/profile" className="focus-ring text-sm text-accent hover:underline">
                  View all
                </Link>
              }
            />
            {data.recentMatches.length ? (
              <div className="flex flex-col gap-2">
                {data.recentMatches.map((match) => (
                  <MatchRowItem key={match.id} match={match} />
                ))}
              </div>
            ) : (
              <EmptyState
                icon="◆"
                title="No duels yet"
                description="Your first match will appear here with its score, reward and settlement."
                action={<ButtonLink href="/play">Start a duel</ButtonLink>}
              />
            )}
          </section>
        </div>

        <div className="flex flex-col gap-6">
          <section>
            <SectionHeader
              title="Achievements"
              subtitle={`${data.achievements.filter((a) => a.unlocked).length} unlocked`}
            />
            <Panel className="flex flex-col gap-2 px-4 py-4">
              {data.achievements.slice(0, 6).map((achievement) => (
                <div
                  key={achievement.code}
                  className={`flex items-center gap-3 rounded-xl px-2.5 py-2 ${
                    achievement.unlocked ? "bg-accent-soft" : "opacity-45"
                  }`}
                >
                  <span aria-hidden className="text-base text-accent">
                    {achievement.icon}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{achievement.name}</p>
                    <p className="truncate text-xs text-dim">{achievement.description}</p>
                  </div>
                </div>
              ))}
            </Panel>
          </section>

          <section>
            <SectionHeader
              title="Recent transactions"
              action={
                <Link href="/transactions" className="focus-ring text-sm text-accent hover:underline">
                  All
                </Link>
              }
            />
            {data.transactions.length ? (
              <div className="flex flex-col gap-2">
                {data.transactions.map((tx) => (
                  <TransactionItem key={tx.id} tx={tx} />
                ))}
              </div>
            ) : (
              <EmptyState icon="◇" title="No transactions" description="Entries, payouts and refunds will show up here." />
            )}
          </section>

          <Panel className="flex flex-col gap-3 px-4 py-4">
            <p className="eyebrow">Career</p>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted">Earned</span>
              <span className="numeric text-success">{formatXlm(profile.total_earned_stroops)} XLM</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted">Wagered</span>
              <span className="numeric">{formatXlm(profile.total_wagered_stroops)} XLM</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted">Fees paid</span>
              <span className="numeric text-dim">{formatXlm(profile.fees_paid_stroops)} XLM</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted">Human duels</span>
              <span className="numeric">{profile.human_games}</span>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function shortWallet(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
