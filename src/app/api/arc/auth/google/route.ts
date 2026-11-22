import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createPkcePair, newState } from "@/lib/auth/oauth";
import { arcGoogleAuthorizeUrl } from "@/lib/arc/google";
import { arcFail } from "@/lib/arc/respond";
import { isProduction, appUrl } from "@/lib/config/env";
export async function GET(request: Request) {
  try {
    if (new URL(request.url).origin !== new URL(appUrl()).origin)
      return NextResponse.redirect(`${appUrl()}/api/arc/auth/google`);
    const state = newState();
    const nonce = newState();
    const { verifier, challenge } = createPkcePair();
    const url = arcGoogleAuthorizeUrl({ state, nonce, challenge });
    const store = await cookies();
    const options = {
      httpOnly: true,
      secure: isProduction(),
      sameSite: "lax" as const,
      path: "/api/arc/auth/google",
      maxAge: 600,
    };
    store.set("cd_arc_google_state", state, options);
    store.set("cd_arc_google_verifier", verifier, options);
    store.set("cd_arc_google_nonce", nonce, options);
    return NextResponse.redirect(url);
  } catch (error) {
    return arcFail(error);
  }
}
