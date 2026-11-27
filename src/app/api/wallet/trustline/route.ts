import { fail, ok, readJson } from "@/lib/api/respond";
import { requireSessionUser } from "@/lib/auth/session";
import { startUsdcTrustline, completeUsdcTrustline } from "@/lib/services/wallet";
import { ChainDuelError } from "@/lib/services/errors";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const userId = (await requireSessionUser()).user.id;
    const body = await readJson<{ action?: string; networkId?: string; requestId?: string; transactionId?: string; signedXdr?: string }>(request);
    if (body.action === "confirm") {
      if (!body.transactionId || !body.signedXdr) throw new ChainDuelError("The signed USDC setup is missing.", "invalid_input");
      return ok(await completeUsdcTrustline({ userId, transactionId: body.transactionId, signedXdr: body.signedXdr }));
    }
    return ok(await startUsdcTrustline({ userId, networkId: body.networkId, requestId: body.requestId }));
  } catch (error) { return fail(error); }
}
