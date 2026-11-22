import { readArcJson } from "@/lib/arc/request";
import { ok } from "@/lib/api/respond";
import { arcFail as fail } from "@/lib/arc/respond";
import { arcSession, sameOrigin } from "@/lib/arc/access";
import { submissionSchema } from "@/lib/arc/api";
import { submitArcResult } from "@/lib/arc/games";
export const maxDuration = 60;
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    sameOrigin(request);
    const session = await arcSession();
    const game = await submitArcResult(
      session.user.id,
      (await params).id,
      submissionSchema.parse(await readArcJson(request)),
    );
    return ok({ game, settled: game.status === "settled", waitingForOpponent: game.status === "active" });
  } catch (error) {
    return fail(error);
  }
}
