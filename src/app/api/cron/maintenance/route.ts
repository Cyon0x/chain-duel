import { fail, ok } from "@/lib/api/respond";
import { rawEnv } from "@/lib/config/env";
import { expireStaleDuels } from "@/lib/services/duel";
import { purgeQueues } from "@/lib/services/matchmaking";
import { ensureSettlementForExpiredMatches } from "@/lib/services/match";
import { ChainDuelError } from "@/lib/services/errors";

export const dynamic = "force-dynamic";

/**
 * Scheduler authentication.
 *
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET` when that env var is
 * set, so we prefer it and fall back to `SESSION_SECRET` (which also allows a
 * manual `?token=` sweep from an operator shell). Comparison is constant-time
 * to avoid leaking the secret through timing.
 */
function authorized(request: Request): boolean {
  const env = rawEnv();
  const header = request.headers.get("authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : null;
  const url = new URL(request.url);
  const token = bearer ?? url.searchParams.get("token");
  if (!token) return false;
  return [env.CRON_SECRET, env.SESSION_SECRET]
    .filter((candidate): candidate is string => Boolean(candidate))
    .some((candidate) => timingSafeEqual(token, candidate));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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
