import { ok, fail } from "@/lib/api/respond";
import { publicStellarConfig } from "@/lib/config/stellar";
import { publicArcConfig } from "@/lib/arc/config";
import { getSessionUser } from "@/lib/auth/session";
export async function GET() {
  try {
    const session = await getSessionUser();
    return ok({ stellar: publicStellarConfig(session?.user.id), arc: publicArcConfig() });
  } catch (error) {
    return fail(error);
  }
}
