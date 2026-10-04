import { fail, ok } from "@/lib/api/respond";
import { requireSessionUser } from "@/lib/auth/session";
import { walletOverview } from "@/lib/services/wallet";

export const dynamic = "force-dynamic";

/** The signed-in player's own wallet: balance, address and recent transfers. */
export async function GET() {
  try {
    const session = await requireSessionUser();
    return ok(await walletOverview(session.user.id));
  } catch (error) {
    return fail(error);
  }
}
