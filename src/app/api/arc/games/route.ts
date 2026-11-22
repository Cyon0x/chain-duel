import { readArcJson } from "@/lib/arc/request";
import { z } from "zod";
import { ok } from "@/lib/api/respond";
import { arcFail as fail } from "@/lib/arc/respond";
import { arcSession, sameOrigin } from "@/lib/arc/access";
import { validateArcRequest } from "@/lib/arc/api";
import { createArcGame } from "@/lib/arc/games";
import { arcDb } from "@/lib/arc/db";
import { arcConfig } from "@/lib/arc/config";
export async function GET() {
  try {
    const session = await arcSession();
    const config = arcConfig();
    const games = await (
      await arcDb()
    ).query(
      `SELECT DISTINCT g.* FROM arc_games g LEFT JOIN arc_players p ON p.game_id=g.id WHERE g.network_id=? AND (p.user_id=? OR g.invited_user_id=?) ORDER BY g.created_at DESC LIMIT 50`,
      [config.networkId, session.user.id, session.user.id],
    );
    return ok({ networkId: config.networkId, games });
  } catch (error) {
    return fail(error);
  }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const body = await readArcJson(request);
    validateArcRequest(body);
    const input = z
      .object({
        mode: z.enum(["pvp", "private", "bot"]),
        amount: z.string().max(24),
        idempotencyKey: z.uuid(),
        invitedUserId: z.string().max(100).optional(),
        gameType: z.literal("pulse"),
      })
      .parse(body);
    const session = await arcSession();
    return ok({
      game: await createArcGame({
        userId: session.user.id,
        mode: input.mode,
        amount: input.amount,
        requestKey: input.idempotencyKey,
        invitedUserId: input.invitedUserId,
      }),
    });
  } catch (error) {
    return fail(error);
  }
}
