import Link from "next/link";
import { redirect } from "next/navigation";
import { CreateDuelPanel } from "@/components/play/create-duel";
import { getSessionUser } from "@/lib/auth/session";
import { ECONOMY, TREASURY_LIMITS } from "@/lib/config/game";

export const dynamic = "force-dynamic";

export default async function PlayFriendPage() {
  const session = await getSessionUser();
  if (!session) redirect("/login");
  if (session.profile?.onboarding_complete !== 1) redirect("/onboarding");

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 pt-4">
      <Link href="/play" className="focus-ring w-fit text-sm text-muted hover:text-ink">
        ← Play hub
      </Link>
      <CreateDuelPanel
        mode="private"
        title="Create private duel"
        description="Set the entry, create the duel, and share one link. Whoever opens it first can accept."
        options={[
          { xlm: 2, label: "Casual" },
          { xlm: 5, label: "Standard" },
          { xlm: 10, label: "High stakes" },
        ]}
        defaultEntry={ECONOMY.defaultEntryStroops / 10_000_000}
        demoAllowed
        maxEntryXlm={TREASURY_LIMITS.maxBotEntryStroops / 10_000_000}
      />
    </div>
  );
}
