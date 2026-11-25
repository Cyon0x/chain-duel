import { fail, ok, readJson } from "@/lib/api/respond";
import { entryStroopsOrThrow } from "@/lib/api/stake";
import { requireSessionUser } from "@/lib/auth/session";
import { cancelQueue, joinQueue, queueStatus } from "@/lib/services/matchmaking";
import { ECONOMY } from "@/lib/config/game";
import { assertStellarRequest, type StellarRequestContext } from "@/lib/api/stellar-context";

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
    const body = await readJson<{ entryXlm?: number; demo?: boolean } & StellarRequestContext>(request);
    const demo = body.demo ?? false;
    assertStellarRequest(body, { demo });
    const entryStroops =
      body.entryXlm !== undefined
        ? entryStroopsOrThrow(body.entryXlm, { demo })
        : ECONOMY.defaultEntryStroops;
    return ok(
      await joinQueue({
        userId: session.user.id,
        entryStroops,
        demo,
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
