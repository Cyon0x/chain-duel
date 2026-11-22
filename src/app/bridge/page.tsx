import { BridgePanel } from "@/components/bridge/bridge-panel";
import { bridgeAvailability } from "@/lib/bridge/config";
export const dynamic = "force-dynamic";
export default function BridgePage() {
  return <BridgePanel availability={bridgeAvailability()} />;
}
