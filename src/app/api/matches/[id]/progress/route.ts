import { fail, numeric, ok, readJson } from "@/lib/api/respond";
import { requireSessionUser } from "@/lib/auth/session";
import { recordProgress } from "@/lib/services/match";

export const dynamic = "force-dynamic";

/**
 * Lightweight provisional score ping so the HUD can render a live opponent.
 * This value is explicitly *not* authoritative and is never used for
 * settlement — the verified event log submitted at the end of the duel is.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSessionUser();
    const { id } = await params;
    const body = await readJson<{ score?: number; combo?: number; hits?: number; misses?: number; atMs?: number }>(
      request,
    );
    await recordProgress({
      gameId: id,
      userId: session.user.id,
      score: numeric(body.score),
      combo: numeric(body.combo),
      hits: numeric(body.hits),
      misses: numeric(body.misses),
      atMs: numeric(body.atMs),
    });
    return ok({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
