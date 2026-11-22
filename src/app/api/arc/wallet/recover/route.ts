import { readArcJson } from "@/lib/arc/request";
import { ok } from "@/lib/api/respond";
import { arcFail as fail } from "@/lib/arc/respond";
import { arcSession, sameOrigin } from "@/lib/arc/access";
import { recoverArcWallet } from "@/lib/arc/circle";
import { validateArcRequest } from "@/lib/arc/api";
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    validateArcRequest(await readArcJson(request));
    const session = await arcSession();
    return ok(await recoverArcWallet(session.user.id));
  } catch (error) {
    return fail(error);
  }
}
