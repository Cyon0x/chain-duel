import { BridgePanel } from "@/components/bridge/bridge-panel";
import { bridgeAvailability } from "@/lib/bridge/config";
import { getSessionUser } from "@/lib/auth/session";
export const dynamic = "force-dynamic";
export default async function BridgePage() {
  const session = await getSessionUser();
  return <BridgePanel availability={bridgeAvailability(session?.user.id)} />;
}
