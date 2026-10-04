import { redirect } from "next/navigation";
import { WalletPanel, type WalletOverviewView } from "@/components/wallet/wallet-panel";
import { getSessionUser } from "@/lib/auth/session";
import { walletOverview } from "@/lib/services/wallet";

export const dynamic = "force-dynamic";

export default async function WalletPage() {
  const session = await getSessionUser();
  if (!session) redirect("/login?next=/wallet");

  const overview = await walletOverview(session.user.id);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 pt-2">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Wallet</p>
          <h1 className="text-display mt-2 text-4xl">Your Wallet</h1>
          <p className="mt-2 max-w-lg text-sm text-muted">
            Deposit, send and track XLM. This is your own wallet — Chain Duel never exposes a secret key.
          </p>
        </div>
      </div>
      <WalletPanel initial={overview as unknown as WalletOverviewView} />
    </div>
  );
}
