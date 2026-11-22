import { ok } from "@/lib/api/respond";
import { arcFail as fail } from "@/lib/arc/respond";
import { arcSession } from "@/lib/arc/access";
import { arcGameView } from "@/lib/arc/games";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await arcSession();
    return ok(await arcGameView(session.user.id, (await params).id));
  } catch (error) {
    return fail(error);
  }
}
