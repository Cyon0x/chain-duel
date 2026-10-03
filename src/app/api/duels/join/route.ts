import { fail, ok, readJson } from "@/lib/api/respond";
import { requireSessionUser } from "@/lib/auth/session";
import { joinDuel } from "@/lib/services/duel";
import { ChainDuelError } from "@/lib/services/errors";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const session = await requireSessionUser();
    const body = await readJson<{ code?: string; gameId?: string }>(request);
    if (!body.code && !body.gameId) throw new ChainDuelError("A duel code is required.", "invalid_request");
    const result = await joinDuel({
      userId: session.user.id,
      code: body.code,
      gameId: body.gameId,
    });
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
