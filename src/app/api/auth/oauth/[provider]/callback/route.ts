import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { fail } from "@/lib/api/respond";
import { exchangeCode, type OAuthProvider } from "@/lib/auth/oauth";
import { issueSession } from "@/lib/auth/session";
import { signInWithProvider } from "@/lib/services/accounts";
import { appUrl } from "@/lib/config/env";
import { ChainDuelError } from "@/lib/services/errors";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  try {
    if (provider !== "google" && provider !== "x") {
      throw new ChainDuelError("Unsupported sign-in provider.", "unsupported_provider", 404);
    }
    const typed = provider as OAuthProvider;
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      throw new ChainDuelError("The sign-in attempt was cancelled.", "oauth_cancelled", 400);
    }
    const store = await cookies();
    const expectedState = store.get(`cd_oauth_state_${typed}`)?.value;
    const verifier = store.get(`cd_oauth_verifier_${typed}`)?.value;
    if (!expectedState || expectedState !== state) {
      throw new ChainDuelError("Sign-in state did not match. Please try again.", "oauth_state_mismatch", 400);
    }
    if (!verifier) {
      throw new ChainDuelError("Sign-in session expired. Please try again.", "oauth_expired", 400);
    }
    store.delete(`cd_oauth_state_${typed}`);
    store.delete(`cd_oauth_verifier_${typed}`);

    const profile = await exchangeCode({ provider: typed, code, codeVerifier: verifier });
    const { userId } = await signInWithProvider({
      provider: typed,
      providerAccountId: profile.providerAccountId,
      email: profile.email,
      displayName: profile.displayName,
      avatar: profile.avatar,
    });
    await issueSession({
      userId,
      walletAddress: null,
      userAgent: request.headers.get("user-agent"),
    });
    return NextResponse.redirect(`${appUrl()}/dashboard`);
  } catch (error) {
    const { body } = { body: error instanceof Error ? error.message : "Sign-in failed." };
    void fail(error);
    return NextResponse.redirect(`${appUrl()}/login?error=${encodeURIComponent(body)}`);
  }
}
