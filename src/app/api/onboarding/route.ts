import { fail, ok, readJson } from "@/lib/api/respond";
import { requireSessionUser } from "@/lib/auth/session";
import { completeOnboarding } from "@/lib/services/accounts";
import { ChainDuelError } from "@/lib/services/errors";
import { isThemeId } from "@/lib/config/themes";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const session = await requireSessionUser();
    const body = await readJson<{ username?: string; avatar?: string | null; theme?: string }>(request);
    if (!body.username) throw new ChainDuelError("Choose a username to continue.", "username_required");
    if (body.theme && !isThemeId(body.theme)) {
      throw new ChainDuelError("Unknown theme.", "invalid_theme");
    }
    const result = await completeOnboarding(session.user.id, {
      username: body.username,
      avatar: body.avatar ?? null,
      theme: body.theme,
    });
    if (!result.ok) throw new ChainDuelError(result.error, "invalid_username");
    return ok({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
