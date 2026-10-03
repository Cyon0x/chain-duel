import { fail, numeric, ok } from "@/lib/api/respond";
import { leaderboard } from "@/lib/services/profile";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const rows = await leaderboard({
      limit: numeric(url.searchParams.get("limit"), 50),
      offset: numeric(url.searchParams.get("offset"), 0),
    });
    return ok({ leaderboard: rows });
  } catch (error) {
    return fail(error);
  }
}
