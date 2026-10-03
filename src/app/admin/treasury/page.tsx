import { notFound, redirect } from "next/navigation";
import { Badge, ButtonLink } from "@/components/ui";
import { TreasuryPanel } from "@/components/admin/treasury-panel";
import { getSessionUser } from "@/lib/auth/session";
import { isAdmin, treasuryDashboard } from "@/lib/services/admin";

export const dynamic = "force-dynamic";

/**
 * Admin treasury console. Deliberately absent from navigation and returns 404
 * for anyone who is not the designated admin wallet — the real gate is the
 * backend `requireAdmin` check plus the contract's `require_admin`.
 */
export default async function AdminTreasuryPage() {
  const session = await getSessionUser();
  if (!session) redirect("/login");
  if (!(await isAdmin(session.user.id))) notFound();

  const dashboard = await treasuryDashboard();

  return (
    <div className="flex flex-col gap-6 pt-2">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Internal</p>
          <h1 className="text-display mt-2 text-4xl">Treasury</h1>
          <p className="mt-2 text-sm text-muted">
            Protocol revenue, bot liquidity and the administrative audit trail.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone="danger">Admin only</Badge>
          <ButtonLink href="/dashboard" variant="ghost" size="sm">
            Back to dashboard
          </ButtonLink>
        </div>
      </header>
      <TreasuryPanel dashboard={dashboard} />
    </div>
  );
}
