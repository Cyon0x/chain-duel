import { fail, ok, readJson } from "@/lib/api/respond";
import { requireSessionUser } from "@/lib/auth/session";
import { dashboardFor, matchHistory, transactionsFor, updatePreferences } from "@/lib/services/profile";
import { isThemeId } from "@/lib/config/themes";
import { ChainDuelError } from "@/lib/services/errors";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireSessionUser();
    const url = new URL(request.url);
    const include = url.searchParams.get("include");
    const dashboard = await dashboardFor(session);
    if (include === "history") {
      return ok({
        dashboard,
        history: await matchHistory(session.user.id),
        transactions: await transactionsFor(session.user.id),
      });
    }
    return ok(dashboard);
  } catch (error) {
    return fail(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await requireSessionUser();
    const body = await readJson<{ theme?: string; avatar?: string | null }>(request);
    if (body.theme && !isThemeId(body.theme)) throw new ChainDuelError("Unknown theme.", "invalid_theme");
    const profile = await updatePreferences(session.user.id, body);
    return ok({ ok: true, theme: profile.theme, avatar: profile.avatar });
  } catch (error) {
    return fail(error);
  }
}
