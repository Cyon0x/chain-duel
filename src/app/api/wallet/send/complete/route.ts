import { fail, ok, readJson } from "@/lib/api/respond";
import { requireSessionUser } from "@/lib/auth/session";
import { completeTransfer } from "@/lib/services/wallet";
import { ChainDuelError } from "@/lib/services/errors";

export const dynamic = "force-dynamic";

/** Submits a transfer the player's external wallet signed. */
export async function POST(request: Request) {
  try {
    const session = await requireSessionUser();
    const body = await readJson<{ transactionId?: string; signedXdr?: string }>(request);
    if (!body.transactionId || !body.signedXdr) {
      throw new ChainDuelError("Missing signed transaction.", "missing_fields");
    }
    return ok(
      await completeTransfer({
        userId: session.user.id,
        transactionId: body.transactionId,
        signedXdr: body.signedXdr,
      }),
    );
  } catch (error) {
    return fail(error);
  }
}
