import { fail, ok } from "@/lib/api/respond";
import { requireSessionUser } from "@/lib/auth/session";
import { loadGameView, startMatch } from "@/lib/services/match";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSessionUser();
    const { id } = await params;
    const game = await startMatch({ gameId: id, userId: session.user.id });
    return ok(await loadGameView(game.id));
  } catch (error) {
    return fail(error);
  }
}
