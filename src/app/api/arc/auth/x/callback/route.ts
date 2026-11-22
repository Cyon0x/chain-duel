import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { exchangeArcX } from "@/lib/arc/x";
import { signInWithProvider } from "@/lib/services/accounts";
import { issueSession, getSessionUser } from "@/lib/auth/session";
import { provisionArcWallet } from "@/lib/arc/circle";
import { arcConfig } from "@/lib/arc/config";
import { appUrl, isProduction } from "@/lib/config/env";
import { NETWORK_COOKIE } from "@/lib/networks/selection";
import { ChainDuelError } from "@/lib/services/errors";
export const maxDuration = 60;
export async function GET(request: Request) {
  const store = await cookies();
  const names = ["cd_arc_x_state", "cd_arc_x_verifier"];
  try {
    const params = new URL(request.url).searchParams;
    const code = params.get("code");
    const state = params.get("state");
    const expected = store.get(names[0])?.value;
    const verifier = store.get(names[1])?.value;
    if (!code || !state || !expected || state !== expected || !verifier)
      throw new ChainDuelError(
        "X sign-in expired or was cancelled. Please retry.",
        "arc_x_state_invalid",
        400,
      );
    for (const name of names) store.set(name, "", { path: "/api/arc/auth/x", maxAge: 0 });
    const profile = await exchangeArcX({ code, verifier });
    const { userId } = await signInWithProvider({
      provider: "x",
      providerAccountId: profile.providerAccountId,
      email: profile.email,
      displayName: profile.displayName,
      avatar: profile.avatar,
    });
    await issueSession({ userId, walletAddress: null, userAgent: request.headers.get("user-agent") });
    store.set(NETWORK_COOKIE, "arc", {
      httpOnly: true,
      secure: isProduction(),
      sameSite: "lax",
      path: "/",
      maxAge: 365 * 86400,
    });
    if (arcConfig().walletEnabled) await provisionArcWallet(userId).catch(() => null);
    const session = await getSessionUser();
    return NextResponse.redirect(
      `${appUrl()}${session?.profile?.onboarding_complete === 1 ? "/arc/wallet" : "/onboarding"}`,
    );
  } catch (error) {
    for (const name of names) store.set(name, "", { path: "/api/arc/auth/x", maxAge: 0 });
    const message =
      error instanceof ChainDuelError ? error.message : "X sign-in could not complete. Please retry.";
    return NextResponse.redirect(`${appUrl()}/arc/login?error=${encodeURIComponent(message)}`);
  }
}
