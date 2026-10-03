import { redirect } from "next/navigation";
import Link from "next/link";
import { AuthPanel } from "@/components/auth-panel";
import { getSessionUser } from "@/lib/auth/session";
import { integrationStatus, demoModeEnabled } from "@/lib/config/env";
import { publicStellarConfig } from "@/lib/config/stellar";
import { Badge } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await getSessionUser();
  if (session) {
    redirect(session.profile?.onboarding_complete === 1 ? "/dashboard" : "/onboarding");
  }
  const { error } = await searchParams;
  const status = integrationStatus();
  const network = publicStellarConfig();

  return (
    <div className="grid items-center gap-10 pt-8 lg:grid-cols-[1fr_minmax(380px,460px)] lg:gap-16">
      <div className="hidden flex-col gap-5 lg:flex">
        <Badge tone="accent">{network.label}</Badge>
        <h2 className="text-display text-4xl">
          One signature.
          <br />
          Then it&apos;s just you
          <br />
          and the targets.
        </h2>
        <ul className="flex flex-col gap-3 text-sm text-muted">
          <li className="panel-flat px-4 py-3">Freighter, xBull, Albedo, LOBSTR and Rabet are supported.</li>
          <li className="panel-flat px-4 py-3">
            Social sign-in provisions a managed Stellar wallet — the key is sealed server-side and never exposed.
          </li>
          <li className="panel-flat px-4 py-3">Demo mode lets you play every mode without staking anything.</li>
        </ul>
        <Link href="/how-to-play" className="focus-ring w-fit text-sm text-accent hover:underline">
          New here? Read how a duel works →
        </Link>
      </div>
      <AuthPanel providers={{ ...status, demoMode: demoModeEnabled() }} error={error} />
    </div>
  );
}
