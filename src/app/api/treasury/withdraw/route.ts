import { fail, ok, readJson } from "@/lib/api/respond";
import { requireSessionUser } from "@/lib/auth/session";
import { withdrawTreasury } from "@/lib/services/admin";
import { ChainDuelError } from "@/lib/services/errors";
import { decimalUnits } from "@/lib/stellar/payments";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const session = await requireSessionUser();
    const body = await readJson<{ amountXlm?: number; amount?: string; kind?: "protocol" | "ecosystem"; requestId?: string; networkId?: string; currency?: string }>(request);
    if (body.amount === undefined && body.amountXlm === undefined) {
      throw new ChainDuelError("Enter an amount to withdraw.", "invalid_amount");
    }
    const units = decimalUnits(String(body.amount ?? body.amountXlm));
    if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new ChainDuelError("Enter a valid withdrawal amount.", "invalid_amount");
    const result = await withdrawTreasury({ userId: session.user.id, amountStroops: Number(units), kind: body.kind, requestId: body.requestId, networkId: body.networkId, currency: body.currency });
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
