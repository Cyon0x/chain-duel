import Link from "next/link";
import { JoinDuelPanel } from "@/components/play/join-duel";
import { EmptyState, ButtonLink } from "@/components/ui";
import { inviteByCode } from "@/lib/services/duel";
import { getSessionUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function DuelInvitePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const session = await getSessionUser();
  const invite = await inviteByCode(code.toUpperCase());

  if (!invite) {
    return (
      <div className="pt-10">
        <EmptyState
          icon="◇"
          title="Invitation not found"
          description="This duel link is invalid, expired or has already been completed."
          action={<ButtonLink href="/play">Go to play</ButtonLink>}
        />
      </div>
    );
  }

  const { game, creatorUsername, invite: inviteRow } = invite;
  const closed = game.status !== "waiting" || inviteRow.status === "expired" || inviteRow.status === "cancelled";

  if (closed) {
    return (
      <div className="pt-10">
        <EmptyState
          icon="⌛"
          title="This duel is no longer open"
          description={
            game.status === "settled" || game.status === "finished"
              ? "This duel has already been played and settled."
              : "The invitation expired or was cancelled. Ask for a fresh link."
          }
          action={<ButtonLink href="/play">Play online instead</ButtonLink>}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 pt-6">
      <Link href="/play" className="focus-ring mx-auto w-full max-w-lg text-sm text-muted hover:text-ink">
        ← Play hub
      </Link>
      <JoinDuelPanel
        code={game.code}
        creatorUsername={creatorUsername}
        creatorAvatar={null}
        entryStroops={game.entry_stroops}
        demo={game.demo === 1}
        isSelf={session?.user.id === game.creator_id}
        authenticated={Boolean(session)}
      />
    </div>
  );
}
