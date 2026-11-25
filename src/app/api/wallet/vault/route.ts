import { fail, ok, readJson } from "@/lib/api/respond";
import { requireSessionUser } from "@/lib/auth/session";
import { createVaultChallenge, playerVaultView, registerPlayerVault } from "@/lib/services/player-vault";
import { ChainDuelError } from "@/lib/services/errors";

export const dynamic = "force-dynamic";
export async function GET() {
  try { const session = await requireSessionUser(); return ok(await playerVaultView(session.user.id)); } catch (error) { return fail(error); }
}
export async function POST(request: Request) {
  try {
    const session = await requireSessionUser();
    const body = await readJson<{ action?: string; enrollment?: unknown }>(request);
    if (body.action === "challenge") return ok(await createVaultChallenge(session.user.id));
    if (body.action === "register" && Object.keys(body).every(key => ["action", "enrollment"].includes(key))) return ok(await registerPlayerVault(session.user.id, body.enrollment));
    throw new ChainDuelError("Invalid player wallet operation.", "invalid_request", 422);
  } catch (error) { return fail(error); }
}
