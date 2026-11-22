import { readArcJson } from "@/lib/arc/request";
import { ok } from "@/lib/api/respond";
import { arcFail as fail } from "@/lib/arc/respond";
import { arcSession, sameOrigin } from "@/lib/arc/access";
import { reconcileArcWallet } from "@/lib/arc/circle";
import { validateArcRequest } from "@/lib/arc/api";
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    validateArcRequest(await readArcJson(request));
    const session = await arcSession();
    const wallet = await reconcileArcWallet(session.user.id);
    return ok({ wallet: wallet ? { address: wallet.address, status: wallet.status } : null });
  } catch (error) {
    return fail(error);
  }
}
