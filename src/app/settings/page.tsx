import Link from "next/link";
import { redirect } from "next/navigation";
import { SettingsPanel } from "@/components/settings-panel";
import { getSessionUser } from "@/lib/auth/session";
import { publicStellarConfig } from "@/lib/config/stellar";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await getSessionUser();
  if (!session) redirect("/login");
  const network = publicStellarConfig();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 pt-2">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Preferences</p>
          <h1 className="text-display mt-2 text-4xl">Settings</h1>
        </div>
        <Link href="/profile" className="focus-ring text-sm text-accent hover:underline">
          Back to profile →
        </Link>
      </div>
      <SettingsPanel
        username={session.profile?.username ?? "Duelist"}
        wallet={
          session.primaryWallet
            ? {
                address: session.primaryWallet.address,
                custody: session.primaryWallet.custody,
                network: network.label,
                provider: session.primaryWallet.provider,
              }
            : null
        }
      />
    </div>
  );
}
