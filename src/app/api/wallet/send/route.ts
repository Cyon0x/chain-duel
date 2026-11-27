import { fail, ok, readJson } from "@/lib/api/respond";
import { requireSessionUser } from "@/lib/auth/session";
import { startTransfer } from "@/lib/services/wallet";
import { ChainDuelError } from "@/lib/services/errors";

export const dynamic = "force-dynamic";

/**
 * Starts an XLM transfer from the player's own wallet. Managed (embedded)
 * wallets are signed server-side and return a confirmed hash; external wallets
 * get an unsigned XDR to sign, which is then submitted via /send/complete.
 */
export async function POST(request: Request) {
  try {
    const session = await requireSessionUser();
    const body = await readJson<{ destination?: string; amountXlm?: string; amount?: string; currency?: "USDC" | "XLM"; networkId?: string; requestId?: string; memo?: string | null }>(request);
    if (!body.destination || !(body.amount ?? body.amountXlm)) {
      throw new ChainDuelError("Enter a destination address and an amount.", "missing_fields");
    }
    return ok(
      await startTransfer({
        userId: session.user.id,
        destination: body.destination,
        amountXlm: body.amount ?? body.amountXlm!,
        currency: body.currency,
        networkId: body.networkId,
        requestId: body.requestId,
        memo: body.memo ?? null,
      }),
    );
  } catch (error) {
    return fail(error);
  }
}
