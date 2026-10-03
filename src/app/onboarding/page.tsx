import { redirect } from "next/navigation";
import { OnboardingForm } from "@/components/onboarding-form";
import { getSessionUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

function suggestionsFor(username: string, address: string | null): string[] {
  const base = username.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 14) || "duelist";
  const seed = address ? address.slice(1, 5).toLowerCase() : "";
  const list = [base];
  if (seed) list.push(`${base.slice(0, 12)}_${seed}`);
  list.push(`${base.slice(0, 10)}${Math.floor(100 + Math.random() * 899)}`);
  return [...new Set(list)].slice(0, 4);
}

export default async function OnboardingPage() {
  const session = await getSessionUser();
  if (!session) redirect("/login");
  if (session.profile?.onboarding_complete === 1) redirect("/dashboard");

  const address = session.primaryWallet?.address ?? null;
  return (
    <div className="pt-8">
      <OnboardingForm
        address={address}
        suggestions={suggestionsFor(session.profile?.username ?? "", address)}
      />
    </div>
  );
}
