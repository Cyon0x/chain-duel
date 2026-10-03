import { fail, numeric, ok } from "@/lib/api/respond";
import { getSessionUser } from "@/lib/auth/session";
import { botAvailability } from "@/lib/services/treasury";
import { ECONOMY, DEFAULT_BOT, TREASURY_LIMITS } from "@/lib/config/game";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const entryStroops = numeric(url.searchParams.get("entryStroops"), ECONOMY.defaultEntryStroops);
    await getSessionUser();
    const availability = await botAvailability(entryStroops);
    // The bot's configured win probability is never included in any client payload.
    return ok({
      available: availability.available,
      reason: availability.reason ?? null,
      opponent: { id: DEFAULT_BOT.id, name: DEFAULT_BOT.name, difficulty: DEFAULT_BOT.difficulty },
      entryStroops: ECONOMY.defaultEntryStroops,
      maxEntryStroops: TREASURY_LIMITS.maxBotEntryStroops,
    });
  } catch (error) {
    return fail(error);
  }
}
