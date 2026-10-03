import { fail, ok } from "@/lib/api/respond";
import { requireSessionUser } from "@/lib/auth/session";
import { gameWithPlayers } from "@/lib/services/duel";
import { ChainDuelError } from "@/lib/services/errors";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const data = await gameWithPlayers(id);
    if (!data) throw new ChainDuelError("That duel does not exist.", "not_found", 404);
    return ok(data);
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSessionUser();
    const { id } = await params;
    const { cancelDuel } = await import("@/lib/services/duel");
    const game = await cancelDuel({ userId: session.user.id, gameId: id });
    return ok({ game });
  } catch (error) {
    return fail(error);
  }
}
