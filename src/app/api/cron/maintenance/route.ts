import { fail, ok } from "@/lib/api/respond";
import { rawEnv } from "@/lib/config/env";
import { expireStaleDuels } from "@/lib/services/duel";
import { purgeQueues } from "@/lib/services/matchmaking";
import { ensureSettlementForExpiredMatches } from "@/lib/services/match";
import { ChainDuelError } from "@/lib/services/errors";

export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const secret = rawEnv().SESSION_SECRET;
  const header = request.headers.get("authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : null;
  const url = new URL(request.url);
  const token = bearer ?? url.searchParams.get("token");
  if (!secret || !token) return false;
  return token === secret;
}

async function run(request: Request) {
  try {
    if (!authorized(request)) {
      throw new ChainDuelError("Not authorised.", "forbidden", 403);
    }
    const [duels, queues, settled] = await Promise.all([
      expireStaleDuels(25),
      purgeQueues(),
      ensureSettlementForExpiredMatches(10),
    ]);
    return ok({
      expiredDuels: duels.refunded,
      expiredQueueEntries: queues.expired,
      settledMatches: settled,
      time: new Date().toISOString(),
    });
  } catch (error) {
    return fail(error);
  }
}

export async function GET(request: Request) {
  return run(request);
}

export async function POST(request: Request) {
  return run(request);
}
