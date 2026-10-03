import { fail, numeric, ok, readJson } from "@/lib/api/respond";
import { requireSessionUser } from "@/lib/auth/session";
import { withdrawTreasury } from "@/lib/services/admin";
import { ChainDuelError } from "@/lib/services/errors";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const session = await requireSessionUser();
    const body = await readJson<{ amountXlm?: number }>(request);
    if (body.amountXlm === undefined) {
      throw new ChainDuelError("Enter an amount to withdraw.", "invalid_amount");
    }
    const amountStroops = Math.round(numeric(body.amountXlm) * 10_000_000);
    const result = await withdrawTreasury({ userId: session.user.id, amountStroops });
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
