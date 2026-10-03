import { fail, ok } from "@/lib/api/respond";
import { requireSessionUser } from "@/lib/auth/session";
import { isAdmin, requireAdmin, treasuryDashboard } from "@/lib/services/admin";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await requireSessionUser();
    // The contract is the real gate; this only avoids leaking the dashboard.
    if (!(await isAdmin(session.user.id))) {
      return ok({ authorized: false });
    }
    await requireAdmin(session.user.id);
    const dashboard = await treasuryDashboard();
    return ok({ authorized: true, dashboard });
  } catch (error) {
    return fail(error);
  }
}
