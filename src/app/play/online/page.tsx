import Link from "next/link";
import { redirect } from "next/navigation";
import { QueuePanel } from "@/components/play/queue-panel";
import { getSessionUser } from "@/lib/auth/session";
import { ECONOMY, TREASURY_LIMITS } from "@/lib/config/game";

export const dynamic = "force-dynamic";

export default async function PlayOnlinePage() {
  const session = await getSessionUser();
  if (!session) redirect("/login");
  if (session.profile?.onboarding_complete !== 1) redirect("/onboarding");

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 pt-4">
      <Link href="/play" className="focus-ring w-fit text-sm text-muted hover:text-ink">
        ← Play hub
      </Link>
      <QueuePanel
        options={[
          { xlm: 2, label: "Casual" },
          { xlm: 5, label: "Standard" },
          { xlm: 10, label: "High stakes" },
        ]}
        defaultEntry={ECONOMY.defaultEntryStroops / 10_000_000}
        demoAllowed
        maxEntryXlm={TREASURY_LIMITS.maxBotEntryStroops / 10_000_000}
        selfName={session.profile?.username ?? null}
      />
      <p className="text-center text-xs text-dim">
        Demo queues match you with other demo players and never move funds.
      </p>
    </div>
  );
}
