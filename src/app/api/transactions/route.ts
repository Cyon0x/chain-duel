import { fail, ok } from "@/lib/api/respond";
import { requireSessionUser } from "@/lib/auth/session";
import { transactionsFor } from "@/lib/services/profile";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await requireSessionUser();
    return ok({ transactions: await transactionsFor(session.user.id) });
  } catch (error) {
    return fail(error);
  }
}
