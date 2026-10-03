import { fail, ok, readJson } from "@/lib/api/respond";
import { issueSession } from "@/lib/auth/session";
import { demoModeEnabled } from "@/lib/config/env";
import { signInDemo } from "@/lib/services/accounts";
import { ChainDuelError } from "@/lib/services/errors";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    if (!demoModeEnabled()) {
      throw new ChainDuelError("Demo mode is disabled on this deployment.", "demo_disabled", 403);
    }
    const body = await readJson<{ name?: string }>(request);
    const { userId } = await signInDemo(body.name);
    await issueSession({ userId, walletAddress: null, userAgent: request.headers.get("user-agent") });
    return ok({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
