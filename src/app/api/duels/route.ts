import { fail, numeric, ok, readJson } from "@/lib/api/respond";
import { requireSessionUser } from "@/lib/auth/session";
import { createDuel, openDuels } from "@/lib/services/duel";
import { ChainDuelError } from "@/lib/services/errors";
import { ECONOMY } from "@/lib/config/game";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const games = await openDuels();
    return ok({ games });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireSessionUser();
    const body = await readJson<{
      mode?: "pvp" | "private" | "bot";
      entryXlm?: number;
      demo?: boolean;
      invitedUsername?: string;
    }>(request);
    const mode = body.mode ?? "private";
    if (!["pvp", "private", "bot"].includes(mode)) {
      throw new ChainDuelError("Unknown duel mode.", "invalid_mode");
    }
    const demo = body.demo ?? false;
    const entryStroops =
      body.entryXlm !== undefined
        ? Math.round(numeric(body.entryXlm) * 10_000_000)
        : ECONOMY.defaultEntryStroops;

    if (body.invitedUsername) {
      const { challengePlayer } = await import("@/lib/services/duel");
      const creation = await challengePlayer({
        fromUserId: session.user.id,
        toUsername: body.invitedUsername,
        entryStroops,
        demo,
      });
      return ok({ game: creation.game, invite: creation.invite, escrow: creation.escrow });
    }

    const creation = await createDuel({
      userId: session.user.id,
      mode,
      entryStroops,
      demo,
    });
    return ok({ game: creation.game, invite: creation.invite, escrow: creation.escrow, bot: creation.bot });
  } catch (error) {
    return fail(error);
  }
}
