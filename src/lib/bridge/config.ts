import "server-only";
import { stellarNetwork } from "../config/stellar";
import { arcConfig } from "../arc/config";
export function bridgeAvailability() {
  const arc = arcConfig();
  const verified = process.env.BRIDGE_E2E_VERIFIED === "true";
  const reviewed = process.env.BRIDGE_SECURITY_REVIEWED === "true";
  const enabled = arc.walletEnabled && verified && reviewed && process.env.BRIDGE_ENABLED === "true";
  return {
    officiallySupported: true,
    infrastructure: "Circle CCTP V2",
    domains: { stellar: 27, arc: 26 },
    enabled,
    stellarNetwork: arc.testnet ? "Stellar Testnet" : "Stellar Mainnet",
    stellarGamingNetwork: stellarNetwork().label,
    arcNetwork: arc.name,
    environmentsMatch: true,
    reason: enabled
      ? "Approve each step. A transfer completes after destination settlement is verified."
      : "USDC transfers are awaiting Circle wallet configuration, security review and tests in both directions.",
    documentation: "https://developers.circle.com/cctp/quickstarts/transfer-usdc-stellar-arc",
  };
}
