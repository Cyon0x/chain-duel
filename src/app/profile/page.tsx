import Link from "next/link";
import { redirect } from "next/navigation";
import clsx from "clsx";
import { Avatar, Badge, ButtonLink, EmptyState, Panel, SectionHeader, Stat } from "@/components/ui";
import { MatchRowItem, TransactionItem } from "@/components/lists";
import { getSessionUser } from "@/lib/auth/session";
import { dashboardFor, matchHistory } from "@/lib/services/profile";
import { formatXlm } from "@/lib/config/game";
import { truncateAddress, accountExplorerUrl } from "@/lib/explorer";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const session = await getSessionUser();
  if (!session) redirect("/login");
  if (session.profile?.onboarding_complete !== 1) redirect("/onboarding");

  const data = await dashboardFor(session);
  const history = await matchHistory(session.user.id);
  const profile = data.profile;
  const winRate = profile.games_played ? Math.round((profile.wins / profile.games_played) * 100) : 0;
  const human = history.matches.filter((match) => match.mode !== "bot");
  const bot = history.matches.filter((match) => match.mode === "bot");

  return (
    <div className="flex flex-col gap-7 pt-2">
      <Panel className="flex flex-col gap-6 px-5 py-6 sm:px-7">
        <div className="flex flex-wrap items-center gap-5">
          <Avatar name={profile.username} src={profile.avatar} size={76} theme={profile.theme} />
          <div className="min-w-0 flex-1">
            <p className="eyebrow">Your profile</p>
            <h1 className="text-display mt-1 text-3xl">{profile.username}</h1>
            <p className="mt-1 text-sm text-muted">
              Rank #{data.rank} · reputation {profile.reputation} · {profile.human_games} human duels
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <Badge tone="accent">{profile.rating} rating</Badge>
            <ButtonLink href="/settings" size="sm" variant="secondary">
              Edit settings
            </ButtonLink>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Wins" value={profile.wins} tone="success" />
          <Stat label="Losses" value={profile.losses} />
          <Stat label="Win rate" value={`${winRate}%`} />
          <Stat label="Streak" value={profile.current_streak} hint={`Best ${profile.best_streak}`} />
          <Stat label="Earned" value={`${formatXlm(profile.total_earned_stroops)}`} hint="XLM" tone="accent" />
          <Stat label="Fees paid" value={`${formatXlm(profile.fees_paid_stroops)}`} hint="XLM" />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="panel-flat px-4 py-3">
            <p className="eyebrow">Wallet</p>
            {data.wallet ? (
              <a
                href={accountExplorerUrl(data.wallet.address)}
                target="_blank"
                rel="noreferrer"
                className="focus-ring numeric mt-1.5 block truncate text-sm text-accent hover:underline"
              >
                {truncateAddress(data.wallet.address, 6)}
              </a>
            ) : (
              <p className="mt-1.5 text-sm text-muted">Managed wallet</p>
            )}
            <p className="mt-1 text-xs text-dim capitalize">{data.wallet?.custody ?? "managed"} custody</p>
          </div>
          <div className="panel-flat px-4 py-3">
            <p className="eyebrow">Balance</p>
            <p className="numeric mt-1.5 text-lg font-semibold text-accent">{data.balanceXlm ?? "—"} XLM</p>
            <p className="mt-1 text-xs text-dim">Native Testnet balance, live from Horizon</p>
          </div>
        </div>
      </Panel>

      <section>
        <SectionHeader title="Achievements" subtitle={`${data.achievements.filter((a) => a.unlocked).length} of ${data.achievements.length} unlocked`} />
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {data.achievements.map((achievement) => (
            <div
              key={achievement.code}
              className={clsx(
                "panel-flat flex items-center gap-3 px-4 py-3",
                achievement.unlocked ? "" : "opacity-40",
              )}
            >
              <span aria-hidden className="text-lg text-accent">
                {achievement.icon}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{achievement.name}</p>
                <p className="truncate text-xs text-dim">{achievement.description}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <SectionHeader title="Human duels" subtitle={`${human.length} matches`} />
          {human.length ? (
            <div className="flex flex-col gap-2">
              {human.slice(0, 10).map((match) => (
                <MatchRowItem key={match.id} match={match} />
              ))}
            </div>
          ) : (
            <EmptyState icon="◈" title="No human duels" description="Challenge a player to start your ranked record." />
          )}
        </section>
        <section>
          <SectionHeader title="Computer duels" subtitle={`${bot.length} matches · unrated`} />
          {bot.length ? (
            <div className="flex flex-col gap-2">
              {bot.slice(0, 10).map((match) => (
                <MatchRowItem key={match.id} match={match} />
              ))}
            </div>
          ) : (
            <EmptyState icon="⌘" title="No computer duels" description="Face VEX-7 to practise without risking rating." />
          )}
        </section>
      </div>

      <section>
        <SectionHeader
          title="Recent transactions"
          action={
            <Link href="/transactions" className="focus-ring text-sm text-accent hover:underline">
              View all
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
          <EmptyState icon="◇" title="No transactions" description="Your duel economy will show up here." />
        )}
      </section>
    </div>
  );
}
