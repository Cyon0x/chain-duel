import { fail, ok, readJson } from "@/lib/api/respond";
import { requireSessionUser } from "@/lib/auth/session";
import { recoverWalletTransaction } from "@/lib/services/wallet";
import { ChainDuelError } from "@/lib/services/errors";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const userId = (await requireSessionUser()).user.id;
    const body = await readJson<{ transactionId?: string }>(request);
    if (!body.transactionId) throw new ChainDuelError("Choose a saved wallet transaction.", "invalid_input");
    return ok(await recoverWalletTransaction(userId, body.transactionId));
  } catch (error) { return fail(error); }
}
