import "server-only";
import { stellarNetwork } from "../config/stellar";
import { arcConfig } from "../arc/config";
export function bridgeAvailability(userId?: string | null) {
  const arc = arcConfig();
  const verified = process.env.BRIDGE_E2E_VERIFIED === "true";
  const reviewed = process.env.BRIDGE_SECURITY_REVIEWED === "true";
  const publiclyEnabled = arc.walletEnabled && verified && reviewed && process.env.BRIDGE_ENABLED === "true";
  const validationMode = !publiclyEnabled && arc.walletEnabled && reviewed &&
    process.env.VERCEL_ENV === "preview" && process.env.BRIDGE_VALIDATION_ENABLED === "true" &&
    Boolean(userId) && userId === process.env.BRIDGE_VALIDATION_USER_ID;
  const enabled = publiclyEnabled || validationMode;
  return {
    officiallySupported: true,
    infrastructure: "Circle CCTP V2",
    domains: { stellar: 27, arc: 26 },
    enabled,
    validationMode,
    e2eVerified: verified,
    maxAmountUsdc: validationMode ? "0.10" : null,
    stellarNetwork: arc.testnet ? "Stellar Testnet" : "Stellar Mainnet",
    stellarGamingNetwork: stellarNetwork().label,
    stellarGamingAsset: stellarNetwork().id === "mainnet" ? "USDC" : "XLM",
    arcNetwork: arc.name,
    environmentsMatch: true,
    reason: validationMode
      ? "Your account can test transfers up to 0.10 USDC. Approve each step; completion requires verified destination settlement."
      : enabled
      ? "Approve each step. A transfer completes after destination settlement is verified."
      : "USDC transfers are awaiting Circle wallet configuration, security review and tests in both directions.",
    documentation: "https://developers.circle.com/cctp/quickstarts/transfer-usdc-stellar-arc",
  };
}
