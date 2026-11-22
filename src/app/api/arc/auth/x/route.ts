import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { appUrl, isProduction } from "@/lib/config/env";
import { createPkcePair, newState } from "@/lib/auth/oauth";
import { arcXAuthorizeUrl } from "@/lib/arc/x";
import { arcFail } from "@/lib/arc/respond";
export async function GET(request: Request) {
  try {
    if (new URL(request.url).origin !== new URL(appUrl()).origin)
      return NextResponse.redirect(`${appUrl()}/api/arc/auth/x`);
    const state = newState();
    const { verifier, challenge } = createPkcePair();
    const url = arcXAuthorizeUrl({ state, challenge });
    const store = await cookies();
    const options = {
      httpOnly: true,
      secure: isProduction(),
      sameSite: "lax" as const,
      path: "/api/arc/auth/x",
      maxAge: 600,
    };
    store.set("cd_arc_x_state", state, options);
    store.set("cd_arc_x_verifier", verifier, options);
    return NextResponse.redirect(url);
  } catch (error) {
    return arcFail(error);
  }
}
