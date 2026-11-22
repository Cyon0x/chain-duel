import { describe, it, expect, afterEach, vi } from "vitest";
import { parseUsdc, parseArcStake, formatUsdc, arcPoolSplit, ARC_NETWORKS } from "@/lib/networks/arc";
import { arcConfig } from "@/lib/arc/config";
import { validateArcRequest } from "@/lib/arc/api";
import { readArcJson } from "@/lib/arc/request";
import { circleIdentity } from "@/lib/arc/circle";
import {
  stellarForwarderHook,
  stellarContractBytes32,
  CCTP_ADDRESSES,
  stellarToCctpUnits,
  cctpToStellarUnits,
} from "@/lib/bridge/cctp";
import { bridgeTransition } from "@/lib/bridge/status";
describe("Arc financial and network boundaries", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("keeps official Mainnet distinct from Testnet", () => {
    expect(ARC_NETWORKS["arc-mainnet"].id).toBe(5042);
    expect(ARC_NETWORKS["arc-testnet"].id).toBe(5042002);
    expect(arcConfig().networkId).toBe("arc-mainnet");
  });
  it("does not activate incomplete wallets or financial contracts", () => {
    vi.stubEnv("ARC_WALLETS_ENABLED", "true");
    vi.stubEnv("ARC_GAMING_ENABLED", "true");
    vi.stubEnv("CIRCLE_API_KEY", "");
    vi.stubEnv("NEXT_PUBLIC_CIRCLE_APP_ID", "");
    expect(arcConfig().walletEnabled).toBe(false);
    expect(arcConfig().gamingEnabled).toBe(false);
  });
  it("rejects Testnet Circle credentials on Mainnet", () => {
    vi.stubEnv("ARC_NETWORK", "mainnet");
    vi.stubEnv("ARC_WALLETS_ENABLED", "true");
    vi.stubEnv("CIRCLE_API_KEY", "TEST_API_KEY:test-only");
    vi.stubEnv("NEXT_PUBLIC_CIRCLE_APP_ID", "test-app");
    expect(arcConfig().walletEnabled).toBe(false);
  });
  it("uses integer six-decimal USDC amounts", () => {
    expect(parseUsdc("50.000001")).toBe(50_000_001n);
    expect(formatUsdc(50_000_001n)).toBe("50.000001");
    for (const input of ["1e3", "0.0000001", "-1", "NaN", "1.", "1,000", "01"])
      expect(() => parseUsdc(input)).toThrow();
  });
  it("enforces the approved 0.50–1,000 USDC stake range exactly", () => {
    expect(parseArcStake("0.50")).toBe(500000n);
    expect(parseArcStake("1000")).toBe(1000000000n);
    for (const input of ["0", "0.499999", "1000.000001", "1001"])
      expect(() => parseArcStake(input)).toThrow();
  });
  it("conserves every unit across 90/5/5 rounding", () => {
    for (const stake of [1n, 9n, 10n, 999_999n, 50_000_001n, 10_000_000_000n]) {
      const split = arcPoolSplit(stake);
      expect(split.winner + split.protocol + split.ecosystem).toBe(split.pool);
      expect(split.protocol).toBe(split.ecosystem);
    }
  });
  it("rejects network and currency substitution", () => {
    vi.stubEnv("ARC_NETWORK", "mainnet");
    expect(() => validateArcRequest({ networkId: "arc-testnet", currency: "USDC" })).toThrow();
    expect(() => validateArcRequest({ networkId: "arc-mainnet", currency: "XLM" })).toThrow();
  });
  it("bounds request parsing before collection validation", async () => {
    await expect(
      readArcJson(new Request("https://example.com", { method: "POST", body: "x".repeat(300_000) })),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      readArcJson(new Request("https://example.com", { method: "POST", body: "not json" })),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("derives distinct stable Circle identities per verified account/app", () => {
    expect(circleIdentity("u1", "app")).toBe(circleIdentity("u1", "app"));
    expect(circleIdentity("u1", "app")).not.toBe(circleIdentity("u2", "app"));
    expect(circleIdentity("u1", "app")).not.toBe(circleIdentity("u1", "other-app"));
  });
});
describe("CCTP route safeguards", () => {
  it("uses valid published Stellar forwarders", () => {
    for (const config of Object.values(CCTP_ADDRESSES))
      expect(stellarContractBytes32(config.stellarForwarder)).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it("encodes recipient type explicitly in forwarder hooks", () => {
    const recipient = CCTP_ADDRESSES.mainnet.stellarForwarder;
    const bytes = Buffer.from(stellarForwarderHook(recipient).slice(2), "hex");
    expect(bytes.readUInt32BE(24)).toBe(0);
    expect(bytes.readUInt32BE(28)).toBe(recipient.length);
    expect(bytes.subarray(32).toString()).toBe(recipient);
    expect(() => stellarForwarderHook("invalid")).toThrow();
  });
  it("prevents silent seven-to-six-decimal truncation", () => {
    expect(stellarToCctpUnits(12340n)).toBe(1234n);
    expect(cctpToStellarUnits(1234n)).toBe(12340n);
    expect(() => stellarToCctpUnits(12341n)).toThrow();
  });
  it("never completes from source confirmation alone", () => {
    expect(() => bridgeTransition("destination_pending", "completed", { sourceHash: "source" })).toThrow();
    expect(
      bridgeTransition("destination_pending", "completed", {
        destinationHash: "destination",
        destinationSettled: true,
      }),
    ).toBe("completed");
    expect(() => bridgeTransition("completed", "submitted")).toThrow();
  });
});
