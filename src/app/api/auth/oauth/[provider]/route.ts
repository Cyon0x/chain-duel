import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { fail } from "@/lib/api/respond";
import { createPkcePair, authorizeUrl, newState, type OAuthProvider } from "@/lib/auth/oauth";
import { isProduction } from "@/lib/config/env";
import { ChainDuelError } from "@/lib/services/errors";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  try {
    const { provider } = await params;
    if (provider !== "google" && provider !== "x") {
      throw new ChainDuelError("Unsupported sign-in provider.", "unsupported_provider", 404);
    }
    const typed = provider as OAuthProvider;
    const state = newState();
    const { verifier, challenge } = createPkcePair();
    const store = await cookies();
    const options = {
      httpOnly: true,
      sameSite: "lax" as const,
      secure: isProduction(),
      path: "/",
      maxAge: 600,
    };
    store.set(`cd_oauth_state_${typed}`, state, options);
    store.set(`cd_oauth_verifier_${typed}`, verifier, options);
    return NextResponse.redirect(authorizeUrl({ provider: typed, state, codeChallenge: challenge }));
  } catch (error) {
    return fail(error);
  }
}
