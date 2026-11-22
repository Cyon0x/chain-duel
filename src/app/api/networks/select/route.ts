import { readArcJson } from "@/lib/arc/request";
import { cookies } from "next/headers";
import { z } from "zod";
import { ok, fail } from "@/lib/api/respond";
import { sameOrigin } from "@/lib/arc/access";
import { NETWORK_COOKIE } from "@/lib/networks/selection";
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const { network } = z.object({ network: z.enum(["stellar", "arc"]) }).parse(await readArcJson(request));
    (await cookies()).set(NETWORK_COOKIE, network, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 365 * 86400,
    });
    return ok({ network });
  } catch (error) {
    return fail(error);
  }
}
