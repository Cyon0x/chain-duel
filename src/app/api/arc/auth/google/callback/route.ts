import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { exchangeArcGoogleCode } from "@/lib/arc/google";
import { signInWithProvider } from "@/lib/services/accounts";
import { issueSession, getSessionUser } from "@/lib/auth/session";
import { provisionArcWallet } from "@/lib/arc/circle";
import { arcConfig } from "@/lib/arc/config";
import { appUrl, isProduction } from "@/lib/config/env";
import { ChainDuelError } from "@/lib/services/errors";
import { NETWORK_COOKIE } from "@/lib/networks/selection";
export const maxDuration = 60;
export async function GET(request: Request) {
  const store = await cookies();
  const names = ["cd_arc_google_state", "cd_arc_google_verifier", "cd_arc_google_nonce"];
  try {
    const params = new URL(request.url).searchParams;
    const code = params.get("code");
    const state = params.get("state");
    const expected = store.get(names[0])?.value;
    const verifier = store.get(names[1])?.value;
    const nonce = store.get(names[2])?.value;
    if (!code || !state || !expected || state !== expected || !verifier || !nonce)
      throw new ChainDuelError(
        "Google sign-in expired or was cancelled. Please retry.",
        "arc_google_state_invalid",
        400,
      );
    for (const name of names) store.set(name, "", { path: "/api/arc/auth/google", maxAge: 0 });
    const profile = await exchangeArcGoogleCode({ code, verifier, nonce });
    const { userId } = await signInWithProvider({
      provider: "google",
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
    // Registration and wallet authorization are separate. Circle records remain pending until the owner completes PIN setup.
    if (arcConfig().walletEnabled) await provisionArcWallet(userId).catch(() => null);
    const session = await getSessionUser();
    return NextResponse.redirect(
      `${appUrl()}${session?.profile?.onboarding_complete === 1 ? "/arc/wallet" : "/onboarding"}`,
    );
  } catch (error) {
    for (const name of names) store.set(name, "", { path: "/api/arc/auth/google", maxAge: 0 });
    const message =
      error instanceof ChainDuelError ? error.message : "Google sign-in could not complete. Please retry.";
    return NextResponse.redirect(`${appUrl()}/arc/login?error=${encodeURIComponent(message)}`);
  }
}
