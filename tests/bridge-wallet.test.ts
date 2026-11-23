import { afterEach, describe, expect, it, vi } from "vitest";
import { signInWithProvider } from "@/lib/services/accounts";
import { db } from "@/lib/db";
import { bridgeStellarWallet } from "@/lib/bridge/stellar";

describe("Public bridge wallet preparation", () => {
  afterEach(() => vi.unstubAllEnvs());
  async function owner() {
    return (await signInWithProvider({ provider: "google", providerAccountId: crypto.randomUUID() })).userId;
  }
  it("reads the owned public identity without decrypting a signing key", async () => {
    const userId = await owner();
    const wallet = await bridgeStellarWallet(userId);
    vi.stubEnv("WALLET_ENCRYPTION_KEY", "different-from-the-key-used-at-registration");
    expect((await bridgeStellarWallet(userId)).address).toBe(wallet.address);
  });
  it("rejects a managed wallet whose signing record is missing", async () => {
    const userId = await owner();
    const wallet = await bridgeStellarWallet(userId);
    await (await db()).execute("DELETE FROM wallet_keys WHERE wallet_id=?", [wallet.id]);
    await expect(bridgeStellarWallet(userId)).rejects.toMatchObject({ code: "bridge_wallet_unavailable" });
  });
  it("preserves the managed-wallet requirement", async () => {
    const userId = await owner();
    const wallet = await bridgeStellarWallet(userId);
    await (await db()).execute("UPDATE wallets SET custody='external' WHERE id=?", [wallet.id]);
    await expect(bridgeStellarWallet(userId)).rejects.toMatchObject({ code: "bridge_wallet_unavailable" });
  });
});
