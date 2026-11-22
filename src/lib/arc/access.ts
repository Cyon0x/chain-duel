import "server-only";
import { requireSessionUser } from "../auth/session";
import { ChainDuelError } from "../services/errors";
import { associatedArcWallet } from "./circle";

export async function arcSession() {
  const session = await requireSessionUser();
  if (session.user.auth_provider !== "google" && session.user.auth_provider !== "x")
    throw new ChainDuelError(
      "Use your Google or X account to set up a Circle wallet.",
      "social_account_required",
      403,
    );
  return session;
}
export async function arcWalletFor(userId: string) {
  const wallet = await associatedArcWallet(userId);
  if (!wallet || wallet.status !== "ready" || !wallet.wallet_id || !wallet.address)
    throw new ChainDuelError("Finish your Arc wallet setup before playing.", "wallet_not_ready", 409);
  return { ...wallet, wallet_id: wallet.wallet_id, address: wallet.address };
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const expected = new URL(request.url).origin;
  if (!origin || origin !== expected)
    throw new ChainDuelError("Please retry this action from Chain Duel.", "origin_invalid", 403);
}
