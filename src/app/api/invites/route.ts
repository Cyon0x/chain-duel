import { fail, ok } from "@/lib/api/respond";
import { requireSessionUser } from "@/lib/auth/session";
import { pendingInvites } from "@/lib/services/duel";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await requireSessionUser();
    return ok({ invites: await pendingInvites(session.user.id) });
  } catch (error) {
    return fail(error);
  }
}
