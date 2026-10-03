import { redirect } from "next/navigation";
import { MatchStage } from "@/components/game/match-stage";
import { getSessionUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function MatchPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionUser();
  const { id } = await params;
  if (!session) redirect(`/login?next=/match/${id}`);
  if (session.profile?.onboarding_complete !== 1) redirect("/onboarding");

  return (
    <div className="pt-2">
      <MatchStage gameId={id} selfUserId={session.user.id} />
    </div>
  );
}
