import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Asset, Networks, StrKey } from "@stellar/stellar-sdk";
import { STELLAR_MAINNET_USDC, STELLAR_MAINNET_USDC_ISSUER, STELLAR_TESTNET_XLM, STELLAR_DEPLOYMENT_ADMIN, stellarPoolSplit } from "@/lib/stellar/shared";

const escrow = StrKey.encodeContract(Buffer.alloc(32, 42)); // Unfunded test fixture; never deployed.
const legacy = "CD3EW4ENWDYGOGQGBJ7G2NU2YV4MLGSQW7CEIBZOYR2NQ4NJ7ZIOZ6FA";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("STELLAR_NETWORK", "mainnet");
  vi.stubEnv("CHAIN_DUEL_MAINNET_CONTRACT_ID", escrow);
  vi.stubEnv("CHAIN_DUEL_STAKE_CONTRACT_ID", legacy);
  vi.stubEnv("CHAIN_DUEL_TOKEN_ID", STELLAR_MAINNET_USDC);
  vi.stubEnv("ADMIN_WALLET_ADDRESS", STELLAR_DEPLOYMENT_ADMIN);
  vi.stubEnv("STELLAR_MAINNET_CONTRACT_REVIEWED", "false");
  vi.stubEnv("STELLAR_MAINNET_E2E_VERIFIED", "false");
  vi.stubEnv("STELLAR_MAINNET_GAMING_ENABLED", "false");
});
afterEach(() => vi.unstubAllEnvs());

describe("Stellar Mainnet configuration boundaries", () => {
  it("derives Circle's Mainnet SAC and publishes only the correct asset and network", async () => {
    expect(new Asset("USDC", STELLAR_MAINNET_USDC_ISSUER).contractId(Networks.PUBLIC)).toBe(STELLAR_MAINNET_USDC);
    vi.stubEnv("SETTLEMENT_SECRET_KEY", "private-fixture-value-not-a-real-key");
    const { publicStellarConfig } = await import("@/lib/config/stellar");
    const config = publicStellarConfig();
    expect(config).toMatchObject({ id: "mainnet", networkPassphrase: Networks.PUBLIC, contractId: escrow, asset: { symbol: "USDC", decimals: 7, issuer: STELLAR_MAINNET_USDC_ISSUER, contractId: STELLAR_MAINNET_USDC }, feeSplit: { winnerBps: 9000, protocolBps: 500, ecosystemBps: 500 }, gamingEnabled: false });
    expect(JSON.stringify(config)).not.toContain("private-fixture-value");
    expect(JSON.stringify(config)).not.toContain("SECRET_KEY");
  });

  it("keeps legacy XLM contracts, endpoints and passphrases when production is Mainnet", async () => {
    vi.stubEnv("STELLAR_RPC_URL", "https://mainnet.sorobanrpc.com");
    vi.stubEnv("STELLAR_HORIZON_URL", "https://horizon.stellar.org");
    vi.stubEnv("STELLAR_NETWORK_PASSPHRASE", Networks.PUBLIC);
    const { stellarNetwork, contractId, tokenContractId } = await import("@/lib/config/stellar");
    expect(stellarNetwork("testnet")).toMatchObject({ networkPassphrase: Networks.TESTNET, rpcUrl: "https://soroban-testnet.stellar.org", horizonUrl: "https://horizon-testnet.stellar.org" });
    expect(contractId("testnet")).toBe(legacy);
    expect(tokenContractId("testnet")).toBe(STELLAR_TESTNET_XLM);
  });

  it.each(["CBBDWEWBBQVQXNYUJ4FA6C2CXXUVDAJSNUOVPZNKTQWK5P2EON7KEGMZ", legacy, STELLAR_TESTNET_XLM, STELLAR_MAINNET_USDC])("rejects %s as the Mainnet game escrow", async id => {
    vi.stubEnv("CHAIN_DUEL_MAINNET_CONTRACT_ID", id);
    const { contractId } = await import("@/lib/config/stellar");
    expect(() => contractId()).toThrow(/independently deployed/);
  });

  it("rejects an unofficial token", async () => {
    vi.stubEnv("CHAIN_DUEL_TOKEN_ID", STELLAR_TESTNET_XLM);
    const { tokenContractId } = await import("@/lib/config/stellar");
    expect(() => tokenContractId()).toThrow(/official Circle USDC/);
  });

  it.each([["STELLAR_RPC_URL", "https://soroban-testnet.stellar.org"], ["STELLAR_HORIZON_URL", "https://horizon-testnet.stellar.org"], ["STELLAR_NETWORK_PASSPHRASE", Networks.TESTNET]])("rejects incompatible %s", async (name, value) => {
    vi.stubEnv(name, value);
    const { stellarNetwork } = await import("@/lib/config/stellar");
    expect(() => stellarNetwork()).toThrow(/Mainnet/);
  });

  it("never opens public stakes before review AND financial verification", async () => {
    vi.stubEnv("STELLAR_MAINNET_CONTRACT_REVIEWED", "true");
    vi.stubEnv("STELLAR_MAINNET_GAMING_ENABLED", "true");
    vi.stubEnv("STELLAR_MAINNET_VALIDATION_USER_IDS", "owner-only");
    const { stellarGamingAllowed } = await import("@/lib/config/stellar");
    expect(stellarGamingAllowed("ordinary-player")).toBe(false);
    expect(stellarGamingAllowed("owner-only")).toBe(true);
  });

  it.each([{ networkId: "stellar-testnet", currency: "XLM" }, { networkId: "stellar-mainnet", currency: "XLM" }, { currency: "USDC" }, {}])("rejects stale or missing Mainnet financial context: %j", async body => {
    const { assertStellarRequest } = await import("@/lib/api/stellar-context");
    expect(() => assertStellarRequest(body)).toThrow();
  });

  it("accepts an acknowledged Mainnet stake and preserves an acknowledged legacy game", async () => {
    const { assertStellarRequest } = await import("@/lib/api/stellar-context");
    expect(() => assertStellarRequest({ networkId: "stellar-mainnet", currency: "USDC", tokenContractId: STELLAR_MAINNET_USDC })).not.toThrow();
    expect(() => assertStellarRequest({ networkId: "stellar-testnet", currency: "XLM" }, { game: { stellar_network: "testnet", currency: "XLM", token_contract_id: STELLAR_TESTNET_XLM } })).not.toThrow();
    expect(() => assertStellarRequest({ networkId: "stellar-mainnet", currency: "USDC", tokenContractId: STELLAR_TESTNET_XLM })).toThrow();
  });

  it("conserves a 100 USDC pot and rounds each fee down without losing any unit", () => {
    expect(stellarPoolSplit(100 * 10_000_000, 500, 500)).toEqual({ protocol: 5 * 10_000_000, ecosystem: 5 * 10_000_000, fee: 10 * 10_000_000, payout: 90 * 10_000_000 });
    for (const pool of [500_000_000, 2_502_469_134, 200_000_000_000]) {
      const result = stellarPoolSplit(pool, 500, 500);
      expect(result.protocol + result.ecosystem + result.payout).toBe(pool);
      expect(result.protocol).toBe(result.ecosystem);
    }
  });
});
