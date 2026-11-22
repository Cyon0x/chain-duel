import { readArcJson } from "@/lib/arc/request";
import { ok } from "@/lib/api/respond";
import { arcFail as fail } from "@/lib/arc/respond";
import { arcSession, sameOrigin } from "@/lib/arc/access";
import { validateArcRequest } from "@/lib/arc/api";
import { authorizeArcOperation, refreshArcOperation } from "@/lib/arc/operations";
export const maxDuration = 60;
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await arcSession();
    return ok({ operation: await refreshArcOperation(session.user.id, (await params).id) });
  } catch (error) {
    return fail(error);
  }
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    sameOrigin(request);
    validateArcRequest(await readArcJson(request));
    const session = await arcSession();
    return ok(await authorizeArcOperation(session.user.id, (await params).id));
  } catch (error) {
    return fail(error);
  }
}
