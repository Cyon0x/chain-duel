import { readArcJson } from "@/lib/arc/request";
import { ok } from "@/lib/api/respond";
import { arcFail as fail } from "@/lib/arc/respond";
import { arcSession, sameOrigin } from "@/lib/arc/access";
import { validateArcRequest } from "@/lib/arc/api";
import { joinArcGame } from "@/lib/arc/games";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    sameOrigin(request);
    validateArcRequest(await readArcJson(request));
    const session = await arcSession();
    return ok({ game: await joinArcGame(session.user.id, (await params).id) });
  } catch (error) {
    return fail(error);
  }
}
