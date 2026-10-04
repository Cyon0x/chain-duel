import { ok } from "@/lib/api/respond";
import { integrationStatus, rawEnv } from "@/lib/config/env";
import { publicStellarConfig } from "@/lib/config/stellar";
import { persistenceStatus } from "@/lib/db";
import { onChainEscrowAvailable } from "@/lib/services/escrow";

export const dynamic = "force-dynamic";

export async function GET() {
  const status = integrationStatus();
  const persistence = await persistenceStatus();
  return ok({
    service: "chain-duel",
    network: publicStellarConfig().id,
    persistence: persistence.mode,
    persistenceAvailable: persistence.available,
    integrations: {
      ...status,
      escrow: onChainEscrowAvailable(),
    },
    demoMode: rawEnv().DEMO_MODE_ENABLED !== "false",
    time: new Date().toISOString(),
  });
}
