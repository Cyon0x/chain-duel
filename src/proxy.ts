import { NextResponse, type NextRequest } from "next/server";
const SHARED = ["/dashboard", "/wallet", "/transactions", "/profile", "/leaderboard", "/play"];
const STELLAR_ACTIONS = ["/api/duels", "/api/matchmaking", "/api/matches", "/api/bot", "/api/wallet"];
export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (request.method === "GET" && path === "/login" && request.cookies.get("cd_ecosystem")?.value === "arc") {
    const target = request.nextUrl.clone();
    target.pathname = "/arc/login";
    return NextResponse.redirect(target);
  }
  if (
    request.method === "GET" &&
    request.cookies.get("cd_ecosystem")?.value === "arc" &&
    SHARED.some((p) => path === p || path.startsWith(`${p}/`))
  ) {
    const target = request.nextUrl.clone();
    target.pathname = path.startsWith("/play") ? "/arc/play" : `/arc${path}`;
    return NextResponse.redirect(target);
  }
  if (STELLAR_ACTIONS.some((p) => path === p || path.startsWith(`${p}/`)) && request.method !== "GET") {
    const header = request.headers.get("x-chain-duel-network");
    let body: Record<string, unknown> = {};
    if (request.headers.get("content-type")?.includes("application/json")) {
      try {
        body = await request.clone().json();
      } catch {}
    }
    const network = header ?? body.networkId ?? body.network;
    if (
      (typeof network === "string" &&
        ![
          "stellar",
          "stellar-mainnet",
          "stellar-testnet",
          "mainnet",
          "testnet",
          "futurenet",
          "local",
        ].includes(network)) ||
      (body.currency !== undefined && body.currency !== "XLM" && !(body.currency === "USDC" && ["stellar-mainnet", "stellar-testnet"].includes(String(network))))
    )
      return NextResponse.json(
        {
          error: "Use the Stellar API with the selected network and asset.",
          code: "network_mismatch",
        },
        { status: 409 },
      );
  }
  return NextResponse.next();
}
export const config = {
  matcher: [
    "/login",
    "/dashboard/:path*",
    "/wallet/:path*",
    "/transactions/:path*",
    "/profile/:path*",
    "/leaderboard/:path*",
    "/play/:path*",
    "/api/duels/:path*",
    "/api/matchmaking/:path*",
    "/api/matches/:path*",
    "/api/bot/:path*",
    "/api/wallet/:path*",
  ],
};
