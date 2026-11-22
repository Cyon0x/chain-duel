import { ok, fail } from "@/lib/api/respond";
import { publicStellarConfig } from "@/lib/config/stellar";
import { publicArcConfig } from "@/lib/arc/config";
export async function GET() {
  try {
    return ok({ stellar: publicStellarConfig(), arc: publicArcConfig() });
  } catch (error) {
    return fail(error);
  }
}
