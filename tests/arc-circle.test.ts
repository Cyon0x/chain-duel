import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
const mock = vi.hoisted(() => ({
  getUser: vi.fn(),
  createUser: vi.fn(),
  createUserToken: vi.fn(),
  listWallets: vi.fn(),
  createUserPinWithWallets: vi.fn(),
  createWallet: vi.fn(),
  getUserChallenge: vi.fn(),
}));
vi.mock("@circle-fin/user-controlled-wallets", () => ({ initiateUserControlledWalletsClient: () => mock }));
import { signInWithProvider } from "@/lib/services/accounts";
import { db } from "@/lib/db";
import {
  provisionArcWallet,
  reconcileArcWallet,
  circleIdentity,
  associatedArcWallet,
} from "@/lib/arc/circle";
describe("Circle user-controlled provisioning", () => {
  beforeEach(() => {
    vi.stubEnv("ARC_NETWORK", "testnet");
    vi.stubEnv("ARC_WALLETS_ENABLED", "true");
    vi.stubEnv("CIRCLE_API_KEY", "TEST_API_KEY:unit-tests-only");
    vi.stubEnv("NEXT_PUBLIC_CIRCLE_APP_ID", "unit-test-app");
    mock.getUser.mockResolvedValue({ data: { user: { pinStatus: "UNSET" } } });
    mock.createUser.mockResolvedValue({ data: {} });
    mock.createUserToken.mockResolvedValue({
      data: { userToken: "unit-test-token", encryptionKey: "unit-test-encryption" },
    });
    mock.listWallets.mockResolvedValue({ data: { wallets: [] } });
    mock.createUserPinWithWallets.mockResolvedValue({ data: { challengeId: "test-challenge" } });
    mock.createWallet.mockResolvedValue({ data: { challengeId: "test-wallet-challenge" } });
    mock.getUserChallenge.mockResolvedValue({ data: { challenge: { status: "PENDING" } } });
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });
  async function account() {
    return signInWithProvider({ provider: "x", providerAccountId: crypto.randomUUID() });
  }
  it("initiates once, resumes the challenge, and associates a verified wallet without changing Stellar", async () => {
    const { userId } = await account();
    const before = await (
      await db()
    ).one<{ primary_wallet: string }>("SELECT primary_wallet FROM users WHERE id=?", [userId]);
    const first = await provisionArcWallet(userId);
    expect(first.challengeId).toBe("test-challenge");
    expect(first.wallet?.address).toBeNull();
    await provisionArcWallet(userId);
    expect(mock.createUserPinWithWallets).toHaveBeenCalledTimes(1);
    mock.listWallets.mockResolvedValue({
      data: {
        wallets: [
          {
            id: `wallet-${userId}`,
            address: "0x1234567890123456789012345678901234567890",
            blockchain: "ARC-TESTNET",
            userId: circleIdentity(userId, "unit-test-app"),
            custodyType: "ENDUSER",
            state: "LIVE",
          },
        ],
      },
    });
    expect((await reconcileArcWallet(userId))?.status).toBe("ready");
    expect((await provisionArcWallet(userId)).challengeId).toBeNull();
    expect(mock.createUserPinWithWallets).toHaveBeenCalledTimes(1);
    expect(await (await db()).one("SELECT primary_wallet FROM users WHERE id=?", [userId])).toEqual(before);
    expect(
      await (
        await db()
      ).query("SELECT * FROM wallet_keys WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id=?)", [
        userId,
      ]),
    ).toHaveLength(1);
  });
  it("never associates an unverified wallet owned by another Circle identity", async () => {
    const { userId } = await account();
    mock.listWallets.mockResolvedValue({
      data: {
        wallets: [
          {
            id: "wrong-owner",
            address: "0x1234567890123456789012345678901234567890",
            blockchain: "ARC-TESTNET",
            userId: "other-account",
            custodyType: "ENDUSER",
            state: "LIVE",
          },
        ],
      },
    });
    await expect(provisionArcWallet(userId)).rejects.toMatchObject({ code: "wallet_ownership_failed" });
    expect((await associatedArcWallet(userId))?.wallet_id).toBeNull();
  });
  it("recovers provisioning failures using the original idempotency key", async () => {
    const { userId } = await account();
    mock.createUserPinWithWallets.mockRejectedValueOnce(new Error("upstream secret detail"));
    await expect(provisionArcWallet(userId)).rejects.toThrow(
      "Circle wallet setup failed. Your account is intact; please retry.",
    );
    const key = (await associatedArcWallet(userId))?.idempotency_key;
    await provisionArcWallet(userId);
    expect(mock.createUserPinWithWallets.mock.calls[1][0].idempotencyKey).toBe(key);
  });
  it("serializes concurrent wallet initialization", async () => {
    const { userId } = await account();
    const results = await Promise.allSettled([provisionArcWallet(userId), provisionArcWallet(userId)]);
    expect(mock.createUserPinWithWallets).toHaveBeenCalledTimes(1);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
  });
  it("uses the existing Circle PIN when adding a supported wallet", async () => {
    const { userId } = await account();
    mock.getUser.mockResolvedValue({ data: { user: { pinStatus: "ENABLED" } } });
    await provisionArcWallet(userId);
    expect(mock.createWallet).toHaveBeenCalledTimes(1);
    expect(mock.createUserPinWithWallets).not.toHaveBeenCalled();
  });
});
