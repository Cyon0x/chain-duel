import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeAvailability } from "@/lib/bridge/config";

describe("Bridge owner validation access", () => {
  beforeEach(() => {
    for (const [key, value] of Object.entries({
      ARC_NETWORK: "mainnet", ARC_WALLETS_ENABLED: "true",
      CIRCLE_API_KEY: "LIVE_API_KEY:unit-test", NEXT_PUBLIC_CIRCLE_APP_ID: "unit-app",
      BRIDGE_ENABLED: "false", BRIDGE_E2E_VERIFIED: "false", BRIDGE_SECURITY_REVIEWED: "true",
      VERCEL_ENV: "preview", BRIDGE_VALIDATION_ENABLED: "true", BRIDGE_VALIDATION_USER_ID: "owner",
    })) vi.stubEnv(key, value);
  });
  afterEach(() => vi.unstubAllEnvs());
  it("exposes capped transfers only to the configured Preview account", () => {
    expect(bridgeAvailability("owner")).toMatchObject({ enabled: true, validationMode: true, e2eVerified: false, maxAmountUsdc: "0.10" });
    expect(bridgeAvailability("other").enabled).toBe(false);
    expect(bridgeAvailability().enabled).toBe(false);
  });
  it.each(["production", "development", ""])("cannot bypass public verification in %s", (environment) => {
    vi.stubEnv("VERCEL_ENV", environment);
    expect(bridgeAvailability("owner").enabled).toBe(false);
  });
  it("requires configured wallets and the security review before owner testing", () => {
    vi.stubEnv("BRIDGE_SECURITY_REVIEWED", "false");
    expect(bridgeAvailability("owner").enabled).toBe(false);
    vi.stubEnv("BRIDGE_SECURITY_REVIEWED", "true");
    vi.stubEnv("ARC_WALLETS_ENABLED", "false");
    expect(bridgeAvailability("owner").enabled).toBe(false);
  });
  it("retains the normal verified public route independently of owner validation", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("BRIDGE_ENABLED", "true");
    vi.stubEnv("BRIDGE_E2E_VERIFIED", "true");
    expect(bridgeAvailability("other")).toMatchObject({ enabled: true, validationMode: false, e2eVerified: true, maxAmountUsdc: null });
  });
});
