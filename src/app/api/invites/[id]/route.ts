import { fail, ok, readJson } from "@/lib/api/respond";
import { requireSessionUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { revertInviteClaim } from "@/lib/db/repositories/duel";
import { joinDuel, respondToInvite } from "@/lib/services/duel";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSessionUser();
    const { id } = await params;
    const body = await readJson<{ accept?: boolean }>(request);
    const response = await respondToInvite({
      inviteId: id,
      userId: session.user.id,
      accept: body.accept !== false,
    });
    if (!response.accepted || !response.gameId) return ok({ accepted: false });
    try {
      const joined = await joinDuel({ userId: session.user.id, gameId: response.gameId });
      return ok({ accepted: true, ...joined });
    } catch (error) {
      // The accept is only real once the entry is locked; otherwise reopen the
      // invitation so the player can retry cleanly.
      await revertInviteClaim(await db(), id, session.user.id);
      throw error;
    }
  } catch (error) {
    return fail(error);
  }
}
