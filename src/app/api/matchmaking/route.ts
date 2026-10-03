import { fail, numeric, ok, readJson } from "@/lib/api/respond";
import { requireSessionUser } from "@/lib/auth/session";
import { cancelQueue, joinQueue, queueStatus } from "@/lib/services/matchmaking";
import { ECONOMY } from "@/lib/config/game";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await requireSessionUser();
    return ok(await queueStatus(session.user.id));
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireSessionUser();
    const body = await readJson<{ entryXlm?: number; demo?: boolean }>(request);
    const entryStroops =
      body.entryXlm !== undefined
        ? Math.round(numeric(body.entryXlm) * 10_000_000)
        : ECONOMY.defaultEntryStroops;
    return ok(
      await joinQueue({
        userId: session.user.id,
        entryStroops,
        demo: body.demo ?? false,
      }),
    );
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE() {
  try {
    const session = await requireSessionUser();
    return ok({ cancelled: await cancelQueue(session.user.id) });
  } catch (error) {
    return fail(error);
  }
}
