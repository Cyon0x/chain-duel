import { fail, ok, readJson } from "@/lib/api/respond";
import { createChallenge, isValidStellarAddress } from "@/lib/auth/stellar";
import { ChainDuelError } from "@/lib/services/errors";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await readJson<{ address?: string }>(request);
    if (!body.address || !isValidStellarAddress(body.address)) {
      throw new ChainDuelError("That does not look like a Stellar address.", "invalid_address");
    }
    const challenge = await createChallenge(body.address);
    return ok(challenge);
  } catch (error) {
    return fail(error);
  }
}
