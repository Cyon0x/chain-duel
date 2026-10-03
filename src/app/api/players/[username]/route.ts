import { fail, ok } from "@/lib/api/respond";
import { getSessionUser } from "@/lib/auth/session";
import { publicProfile } from "@/lib/services/profile";
import { ChainDuelError } from "@/lib/services/errors";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ username: string }> },
) {
  try {
    const { username } = await params;
    const session = await getSessionUser();
    const profile = await publicProfile(username, session?.user.id ?? null);
    if (!profile) throw new ChainDuelError("That player does not exist.", "not_found", 404);
    return ok(profile);
  } catch (error) {
    return fail(error);
  }
}
