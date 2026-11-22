import { readArcJson } from "@/lib/arc/request";
import { z } from "zod";
import { ok } from "@/lib/api/respond";
import { arcFail as fail } from "@/lib/arc/respond";
import { arcSession, sameOrigin } from "@/lib/arc/access";
import { validateArcRequest } from "@/lib/arc/api";
import { prepareArcEntry } from "@/lib/arc/games";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    sameOrigin(request);
    const body = await readArcJson(request);
    validateArcRequest(body);
    const { action } = z.object({ action: z.enum(["approve", "entry", "cancel", "refund"]) }).parse(body);
    const session = await arcSession();
    return ok({ operation: await prepareArcEntry(session.user.id, (await params).id, action) });
  } catch (error) {
    return fail(error);
  }
}
