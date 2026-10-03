import { fail, ok } from "@/lib/api/respond";
import { getSessionUser } from "@/lib/auth/session";
import { directory } from "@/lib/services/profile";
import { numeric } from "@/lib/api/respond";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await getSessionUser();
    const url = new URL(request.url);
    const players = await directory({
      search: url.searchParams.get("search") ?? undefined,
      limit: numeric(url.searchParams.get("limit"), 24),
      offset: numeric(url.searchParams.get("offset"), 0),
      viewerId: session?.user.id ?? null,
    });
    return ok({ players });
  } catch (error) {
    return fail(error);
  }
}
