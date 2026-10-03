import { fail, ok, readJson } from "@/lib/api/respond";
import { requireSessionUser } from "@/lib/auth/session";
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
    const joined = await joinDuel({ userId: session.user.id, gameId: response.gameId });
    return ok({ accepted: true, ...joined });
  } catch (error) {
    return fail(error);
  }
}
