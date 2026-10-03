import { fail, ok, readJson } from "@/lib/api/respond";
import { requireSessionUser } from "@/lib/auth/session";
import { submitResult } from "@/lib/services/match";
import type { HitRecord, MissRecord } from "@/lib/game/pulse";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSessionUser();
    const { id } = await params;
    const body = await readJson<{
      seat?: number;
      hits?: HitRecord[];
      misses?: MissRecord[];
      clientScore?: number;
      clientDurationMs?: number;
    }>(request);
    const result = await submitResult({
      gameId: id,
      userId: session.user.id,
      payload: {
        seat: Number(body.seat ?? 0),
        hits: Array.isArray(body.hits) ? body.hits : [],
        misses: Array.isArray(body.misses) ? body.misses : [],
        clientScore: Number(body.clientScore ?? 0),
        clientDurationMs: body.clientDurationMs,
      },
    });
    return ok({ game: result.game, score: result.score, settled: result.settled });
  } catch (error) {
    return fail(error);
  }
}
