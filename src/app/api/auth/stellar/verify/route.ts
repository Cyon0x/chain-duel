import { fail, ok, readJson } from "@/lib/api/respond";
import { isValidStellarAddress, verifyChallenge } from "@/lib/auth/stellar";
import { issueSession } from "@/lib/auth/session";
import { signInWithWallet } from "@/lib/services/accounts";
import { ChainDuelError } from "@/lib/services/errors";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await readJson<{
      address?: string;
      message?: string;
      signature?: string;
      signerAddress?: string;
    }>(request);
    if (!body.address || !isValidStellarAddress(body.address)) {
      throw new ChainDuelError("That does not look like a Stellar address.", "invalid_address");
    }
    if (!body.message || !body.signature) {
      throw new ChainDuelError("The signed challenge is incomplete.", "invalid_challenge");
    }
    const verification = await verifyChallenge({
      address: body.address,
      message: body.message,
      signature: body.signature,
      signerAddress: body.signerAddress ?? null,
    });
    if (!verification.ok) {
      throw new ChainDuelError(
        `We could not verify that signature (${verification.reason ?? "rejected"}).`,
        "signature_rejected",
        401,
      );
    }
    const { userId, created } = await signInWithWallet(body.address);
    await issueSession({
      userId,
      walletAddress: body.address,
      userAgent: request.headers.get("user-agent"),
    });
    return ok({ ok: true, created });
  } catch (error) {
    return fail(error);
  }
}
