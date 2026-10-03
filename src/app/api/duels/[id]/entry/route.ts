import { fail, ok, readJson } from "@/lib/api/respond";
import { requireSessionUser } from "@/lib/auth/session";
import { commitEntry, confirmWalletEscrow } from "@/lib/services/duel";
import { findGameById } from "@/lib/db/repositories/duel";
import { db } from "@/lib/db";
import { ChainDuelError } from "@/lib/services/errors";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSessionUser();
    const { id } = await params;
    const database = await db();
    const game = await findGameById(database, id);
    if (!game) throw new ChainDuelError("That duel does not exist.", "not_found", 404);

    const body = await readJson<{
      action?: "commit" | "confirm";
      role?: "creator" | "joiner";
      signedXdr?: string;
      transactionId?: string;
    }>(request);

    if (body.action === "confirm") {
      if (!body.signedXdr || !body.transactionId) {
        throw new ChainDuelError("The signed transaction is missing.", "invalid_request");
      }
      const updated = await confirmWalletEscrow({
        gameId: id,
        userId: session.user.id,
        signedXdr: body.signedXdr,
        transactionId: body.transactionId,
      });
      return ok({ game: updated, escrow: { mode: "confirmed" } });
    }

    const role = body.role ?? (game.creator_id === session.user.id ? "creator" : "joiner");
    const result = await commitEntry({ game, userId: session.user.id, role });
    return ok({ game: result.game, escrow: result });
  } catch (error) {
    return fail(error);
  }
}
