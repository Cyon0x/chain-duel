import Link from "next/link";
import { redirect } from "next/navigation";
import { ComputerPanel } from "@/components/play/computer-panel";
import { getSessionUser } from "@/lib/auth/session";
import { ECONOMY, STAKE_PRESETS } from "@/lib/config/game";

export const dynamic = "force-dynamic";

export default async function PlayComputerPage() {
  const session = await getSessionUser();
  if (!session) redirect("/login");
  if (session.profile?.onboarding_complete !== 1) redirect("/onboarding");

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 pt-4">
      <Link href="/play" className="focus-ring w-fit text-sm text-muted hover:text-ink">
        ← Play hub
      </Link>
      <ComputerPanel
        defaultEntryXlm={ECONOMY.defaultEntryStroops / 10_000_000}
        options={STAKE_PRESETS}
      />
      <p className="text-center text-xs text-dim">
        Computer duels do not affect your competitive rating. They are still settled on Stellar.
      </p>
    </div>
  );
}
