import { fail, ok, readJson } from "@/lib/api/respond";
import { requireSessionUser } from "@/lib/auth/session";
import { joinDuel } from "@/lib/services/duel";
import { ChainDuelError } from "@/lib/services/errors";
import { assertStellarRequest, type StellarRequestContext } from "@/lib/api/stellar-context";
import { findGameById, findGameByCode } from "@/lib/db/repositories/duel";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const session = await requireSessionUser();
    const body = await readJson<{ code?: string; gameId?: string } & StellarRequestContext>(request);
    if (!body.code && !body.gameId) throw new ChainDuelError("A duel code is required.", "invalid_request");
    const database = await db();
    const game = body.gameId ? await findGameById(database, body.gameId) : await findGameByCode(database, body.code!);
    if (!game) throw new ChainDuelError("That duel does not exist.", "not_found", 404);
    assertStellarRequest(body, { game, demo: Boolean(game.demo) });
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
