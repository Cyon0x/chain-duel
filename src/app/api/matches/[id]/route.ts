import { fail, ok } from "@/lib/api/respond";
import { requireSessionUser } from "@/lib/auth/session";
import { loadGameView } from "@/lib/services/match";
import { ChainDuelError } from "@/lib/services/errors";
import { ensureSettlementForExpiredMatches } from "@/lib/services/match";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSessionUser();
    const { id } = await params;
    const view = await loadGameView(id);
    if (!view) throw new ChainDuelError("That duel does not exist.", "not_found", 404);
    const isParticipant = view.players.some((player) => player.user_id === session.user.id);
    if (!isParticipant) throw new ChainDuelError("You are not part of this duel.", "forbidden", 403);

    if (view.game.status === "active") {
      await ensureSettlementForExpiredMatches(3);
      const refreshed = await loadGameView(id);
      if (refreshed) return ok(refreshed);
    }
    return ok(view);
  } catch (error) {
    return fail(error);
  }
}
