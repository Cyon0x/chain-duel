import { fail, ok } from "@/lib/api/respond";
import { requireSessionUser } from "@/lib/auth/session";
import { fundOwnWallet } from "@/lib/services/wallet";

export const dynamic = "force-dynamic";

/** Testnet faucet top-up for the player's own unfunded wallet. */
export async function POST() {
  try {
    const session = await requireSessionUser();
    return ok(await fundOwnWallet(session.user.id));
  } catch (error) {
    return fail(error);
  }
}
