import { readArcJson } from "@/lib/arc/request";
import { z } from "zod";
import { ok } from "@/lib/api/respond";
import { arcFail as fail } from "@/lib/arc/respond";
import { arcSession, sameOrigin } from "@/lib/arc/access";
import { validateArcRequest } from "@/lib/arc/api";
import { arcQueue, joinArcQueue, leaveArcQueue } from "@/lib/arc/matchmaking";
export async function GET() {
  try {
    return ok(await arcQueue((await arcSession()).user.id));
  } catch (error) {
    return fail(error);
  }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const body = await readArcJson(request);
    validateArcRequest(body);
    const input = z
      .object({ amount: z.string().max(24), gameType: z.literal("pulse"), mode: z.literal("pvp") })
      .parse(body);
    return ok(await joinArcQueue((await arcSession()).user.id, input.amount));
  } catch (error) {
    return fail(error);
  }
}
export async function DELETE(request: Request) {
  try {
    sameOrigin(request);
    return ok(await leaveArcQueue((await arcSession()).user.id));
  } catch (error) {
    return fail(error);
  }
}
