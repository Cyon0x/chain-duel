import { readArcJson } from "@/lib/arc/request";
import { z } from "zod";
import { ok } from "@/lib/api/respond";
import { arcFail as fail } from "@/lib/arc/respond";
import { arcSession, sameOrigin } from "@/lib/arc/access";
import { arcPlayers, loadArcGame } from "@/lib/arc/games";
import { arcDb } from "@/lib/arc/db";
import { ChainDuelError } from "@/lib/services/errors";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    sameOrigin(request);
    const session = await arcSession();
    const game = await loadArcGame((await params).id);
    if (game.status !== "active" || !(await arcPlayers(game.id)).some((p) => p.user_id === session.user.id))
      throw new ChainDuelError("This duel is unavailable.", "forbidden", 403);
    const { score, atMs } = z
      .object({
        score: z.number().int().min(-100_000).max(100_000),
        atMs: z.number().int().min(0).max(60_000),
      })
      .parse(await readArcJson(request));
    await (
      await arcDb()
    ).execute(
      `INSERT INTO arc_progress(game_id,user_id,score,at_ms,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(game_id,user_id) DO UPDATE SET score=excluded.score,at_ms=excluded.at_ms,updated_at=excluded.updated_at`,
      [game.id, session.user.id, score, atMs, new Date().toISOString()],
    );
    return ok({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
