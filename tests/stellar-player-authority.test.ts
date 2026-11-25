import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Keypair, Networks, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { createDelegatedStellarVault } from "@/lib/wallet/vault-crypto";
import { preparePlayerSignerMigration } from "@/lib/wallet/migration-plan";
import { delegatedPlayerAuthority, hasAccountSigningWeight, type StellarAccountAuthority } from "@/lib/stellar/player-authority";
import { STELLAR_DEPLOYMENT_ADMIN } from "@/lib/stellar/shared";

const old = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(61)); // Unfunded SDK fixture only.
const device = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(62));
const recovery = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(63));
const authority: StellarAccountAuthority = { account_id: old.publicKey(), sequence: "10", subentry_count: 1, thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 }, signers: [{ key: old.publicKey(), weight: 1, type: "ed25519_public_key" }] };
const quote = { baseReserveUnits: 5000000n, nativeBalanceUnits: 100000000n, sellingLiabilitiesUnits: 0n, numSponsoring: 0, numSponsored: 0, activeGames: 0, pendingTransactions: 0 };
const chain = vi.hoisted(() => ({ account: vi.fn() }));
vi.mock("@/lib/services/player-authority", async () => ({ ...await vi.importActual<typeof import("@/lib/services/player-authority")>("@/lib/services/player-authority"), readPlayerAccountAuthority: chain.account }));
beforeEach(async () => {
  if (globalThis.__chainDuelDb) await (await globalThis.__chainDuelDb).driver.close(); delete globalThis.__chainDuelDb;
  vi.resetModules(); vi.stubEnv("STELLAR_NETWORK", "testnet"); vi.stubEnv("STELLAR_PLAYER_SIGNING_MODE", "client");
});
afterEach(() => vi.unstubAllEnvs());
describe("existing-address signer migration planning", () => {
  it("prepares only the two player signers and atomic old-master revocation, preserving the existing address", async () => {
    const vault = await createDelegatedStellarVault(old.publicKey(), "testnet");
    const plan = await preparePlayerSignerMigration(authority, vault.publicVault, "testnet", quote);
    expect(plan).toMatchObject({ walletAddress: old.publicKey(), executionEnabled: false, addressPreserved: true, masterWeightAfter: 0, additionalReserveUnits: "10000000", transactionFeeUnits: "300", explicitPerWalletApprovalRequired: true, independentPlayerKeyConfirmationRequired: true });
    const transaction = TransactionBuilder.fromXDR(plan.unsignedXdr, Networks.TESTNET) as Transaction;
    expect(transaction.source).toBe(old.publicKey()); expect(transaction.signatures).toHaveLength(0);
    expect(transaction.operations).toEqual([
      expect.objectContaining({ type: "setOptions", signer: { ed25519PublicKey: vault.publicVault.deviceSignerAddress, weight: 1 } }),
      expect.objectContaining({ type: "setOptions", signer: { ed25519PublicKey: vault.publicVault.recoverySignerAddress, weight: 1 } }),
      expect.objectContaining({ type: "setOptions", masterWeight: 0, lowThreshold: 1, medThreshold: 1, highThreshold: 1 }),
    ]);
  });
  it("blocks migrations with active liabilities, pending transfers or insufficient XLM reserves", async () => {
    const vault = await createDelegatedStellarVault(old.publicKey(), "testnet");
    await expect(preparePlayerSignerMigration(authority, vault.publicVault, "testnet", { ...quote, activeGames: 1 })).rejects.toThrow("active game");
    await expect(preparePlayerSignerMigration(authority, vault.publicVault, "testnet", { ...quote, pendingTransactions: 1 })).rejects.toThrow("pending wallet");
    await expect(preparePlayerSignerMigration(authority, vault.publicVault, "testnet", { ...quote, nativeBalanceUnits: 20000000n })).rejects.toThrow("Additional XLM");
  });
  it("refuses administrative-wallet changes and unexpected existing authority", async () => {
    const vault = await createDelegatedStellarVault(old.publicKey(), "testnet");
    await expect(preparePlayerSignerMigration({ ...authority, account_id: STELLAR_DEPLOYMENT_ADMIN }, { ...vault.publicVault, walletAddress: STELLAR_DEPLOYMENT_ADMIN }, "testnet", quote)).rejects.toThrow("admin wallet");
    await expect(preparePlayerSignerMigration({ ...authority, signers: [...authority.signers, { key: device.publicKey(), weight: 1, type: "ed25519_public_key" }] }, vault.publicVault, "testnet", quote)).rejects.toThrow("individual review");
  });
});
describe("Stellar current-authority authentication", () => {
  it("accepts the delegated player keys and rejects the cryptographically valid revoked master", async () => {
    const migrated = { ...authority, thresholds: { low_threshold: 1, med_threshold: 1, high_threshold: 1 }, signers: [{ key: old.publicKey(), weight: 0, type: "ed25519_public_key" }, { key: device.publicKey(), weight: 1, type: "ed25519_public_key" }, { key: recovery.publicKey(), weight: 1, type: "ed25519_public_key" }] };
    expect(hasAccountSigningWeight(migrated, old.publicKey())).toBe(false); expect(hasAccountSigningWeight(migrated, device.publicKey())).toBe(true);
    const vault = await createDelegatedStellarVault(old.publicKey(), "testnet");
    const publicVault = { ...vault.publicVault, deviceSignerAddress: device.publicKey(), recoverySignerAddress: recovery.publicKey() };
    expect(delegatedPlayerAuthority(migrated, publicVault)).toBe(true);
    expect(delegatedPlayerAuthority({ ...migrated, signers: [...migrated.signers, { key: STELLAR_DEPLOYMENT_ADMIN, weight: 1, type: "ed25519_public_key" }] }, publicVault)).toBe(false);
    chain.account.mockResolvedValue(migrated);
    const auth = await import("@/lib/auth/stellar");
    const rejected = await auth.createChallenge(old.publicKey());
    const bytes = new TextEncoder().encode(rejected.message); const signature = old.sign(bytes);
    expect(old.verify(bytes, signature)).toBe(true);
    expect(await auth.verifyChallenge({ address: old.publicKey(), message: rejected.message, signature: Buffer.from(signature).toString("hex"), signerAddress: old.publicKey() })).toMatchObject({ ok: false, reason: "signer_no_current_authority" });
    const accepted = await auth.createChallenge(old.publicKey());
    expect(await auth.verifyChallenge({ address: old.publicKey(), message: accepted.message, signature: Buffer.from(device.sign(new TextEncoder().encode(accepted.message))).toString("hex"), signerAddress: device.publicKey() })).toEqual({ ok: true });
  });
});
