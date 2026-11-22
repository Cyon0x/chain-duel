import { readArcJson } from "@/lib/arc/request";
import { ok } from "@/lib/api/respond";
import { arcFail as fail } from "@/lib/arc/respond";
import { arcSession, sameOrigin } from "@/lib/arc/access";
import { provisionArcWallet } from "@/lib/arc/circle";
import { validateArcRequest } from "@/lib/arc/api";
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    validateArcRequest(await readArcJson(request));
    const session = await arcSession();
    return ok(await provisionArcWallet(session.user.id));
  } catch (error) {
    return fail(error);
  }
}
