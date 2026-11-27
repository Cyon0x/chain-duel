import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrKey } from "@stellar/stellar-sdk";
import { createPrimaryStellarVault, createDelegatedStellarVault, signWithClientVault } from "@/lib/wallet/vault-crypto";
import { vaultRegistrationMessage } from "@/lib/wallet/vault-types";
import { bytesHex } from "@/lib/stellar/pulse-codec";

const player = "GBGDTBOXVZ4GIDDRISY5FGXYY7XCWCCK3FRHJHSVFEZMWA3ZZ2HUALTK";
beforeEach(async () => {
  if (globalThis.__chainDuelDb) await (await globalThis.__chainDuelDb).driver.close();
  delete globalThis.__chainDuelDb; vi.resetModules(); vi.stubEnv("STELLAR_NETWORK", "testnet"); vi.stubEnv("STELLAR_PLAYER_SIGNING_MODE", "client");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
async function account(managed = false) {
  const { db } = await import("@/lib/db"); const database = await db(); const identity = await import("@/lib/db/repositories/identity");
  const user = await identity.createUser(database, { authProvider: "google", providerAccountId: crypto.randomUUID() });
  await identity.createProfile(database, { userId: user.id, username: `custody_${user.id.slice(-6)}` });
  let wallet = null;
  if (managed) {
    wallet = await identity.createWallet(database, { userId: user.id, address: player, custody: "managed", provider: "chain-duel-managed", network: "testnet", isPrimary: true });
    await identity.updateUser(database, user.id, { primary_wallet: player });
    await database.execute("INSERT INTO wallet_keys(wallet_id,ciphertext,iv,auth_tag,algo,created_at) VALUES(?,?,?,?,?,?)", [wallet.id, "original-ciphertext-preserved", "fixture-iv", "fixture-auth", "aes-256-gcm", new Date().toISOString()]);
  }
  return { database, identity, user, wallet };
}
async function enrollment(userId: string, vault: Awaited<ReturnType<typeof createPrimaryStellarVault>>) {
  const service = await import("@/lib/services/player-vault"); const challenge = await service.createVaultChallenge(userId);
  const message = vaultRegistrationMessage(challenge.message, vault.publicVault);
  return { service, input: { nonce: challenge.nonce, publicVault: vault.publicVault, deviceProofHex: bytesHex(await signWithClientVault(vault.signer, message)), recoveryProofHex: bytesHex(await signWithClientVault(vault.recoverySigner, message)) } };
}
describe("player-controlled backend custody boundaries", () => {
  it("resolves a legacy wallet without retrieving or decrypting its signing key", async () => {
    const { database, user, wallet } = await account(true); const queries = vi.spyOn(database, "one");
    const signer = await (await import("@/lib/wallet/signer")).signerForUser(user.id);
    expect(signer).toMatchObject({ address: player, canSignServerSide: false, keypair: null });
    expect(queries.mock.calls.some(([query]) => query.includes("wallet_keys"))).toBe(false);
    await expect((await import("@/lib/db/repositories/identity")).loadWalletKey(database, wallet!.id)).rejects.toThrow("unavailable");
    const keys = await import("@/lib/stellar/wallet");
    expect(() => keys.openSecret({ ciphertext: "unusable", iv: "unusable", authTag: "unusable" })).toThrow("cannot access");
    expect(() => keys.generateManagedWallet()).toThrow("player's control");
  });
  it("keeps OAuth identities and lets the browser register a new primary wallet without a server key", async () => {
    const { database, user } = await account(); const vault = await createPrimaryStellarVault("testnet"); const { service, input } = await enrollment(user.id, vault);
    const registered = await service.registerPlayerVault(user.id, input);
    expect(registered).toMatchObject({ walletAddress: vault.signer.walletAddress, provider: "chain-duel-client", custody: "external", status: "client-primary" });
    expect((await database.one<{ count: number }>("SELECT COUNT(*) AS count FROM wallet_keys"))?.count).toBe(0);
    expect(JSON.stringify(await database.one("SELECT * FROM stellar_player_vaults"))).not.toContain(vault.recoverySecret);
    const resumed = await (await import("@/lib/services/accounts")).signInWithProvider({ provider: "google", providerAccountId: user.provider_account_id! });
    expect(resumed.userId).toBe(user.id); expect(resumed.created).toBe(false);
    expect((await database.one<{ primary_wallet: string }>("SELECT primary_wallet FROM users WHERE id = ?", [user.id]))?.primary_wallet).toBe(vault.signer.walletAddress);
  });
  it("does not create a server-held wallet during new Google or X sign-in", async () => {
    const accounts = await import("@/lib/services/accounts"); const { db } = await import("@/lib/db"); const database = await db();
    for (const provider of ["google", "x"] as const) await accounts.signInWithProvider({ provider, providerAccountId: crypto.randomUUID(), displayName: provider });
    expect((await database.one<{ count: number }>("SELECT COUNT(*) AS count FROM users"))?.count).toBe(2);
    expect((await database.one<{ count: number }>("SELECT COUNT(*) AS count FROM wallets"))?.count).toBe(0);
    expect((await database.one<{ count: number }>("SELECT COUNT(*) AS count FROM wallet_keys"))?.count).toBe(0);
  });
  it("keeps existing addresses and ciphertext; backend-generated replacement keys cannot activate a migration", async () => {
    const { database, user } = await account(true); const vault = await createDelegatedStellarVault(player, "testnet"); const { service, input } = await enrollment(user.id, vault);
    const result = await service.registerPlayerVault(user.id, input);
    expect(result).toMatchObject({ walletAddress: player, status: "awaiting-migration-review", custody: "managed" });
    expect((await database.one<{ ciphertext: string }>("SELECT ciphertext FROM wallet_keys"))?.ciphertext).toBe("original-ciphertext-preserved");
    expect((await database.one("SELECT approved_manifest_hash,verified_ledger FROM stellar_player_vaults"))).toEqual({ approved_manifest_hash: null, verified_ledger: null });
    await expect((await import("@/lib/services/player-authority")).assertPlayerWalletReady(user.id, player, "testnet")).rejects.toMatchObject({ code: "player_migration_review_pending" });
    await expect(service.registerPlayerVault(user.id, { ...input, status: "client-delegated" })).rejects.toMatchObject({ code: "invalid_vault" });
  });
  it("refuses an existing-address replacement, even with valid new signer proofs", async () => {
    const { user, database } = await account(true); const vault = await createPrimaryStellarVault("testnet"); const { service, input } = await enrollment(user.id, vault);
    await expect(service.registerPlayerVault(user.id, input)).rejects.toMatchObject({ code: "wallet_already_linked" });
    expect((await database.one<{ primary_wallet: string }>("SELECT primary_wallet FROM users WHERE id = ?", [user.id]))?.primary_wallet).toBe(player);
  });
  it("rejects forged possession proofs, cross-user nonces and enrollment replays", async () => {
    const { user } = await account(); const other = await account(); const vault = await createPrimaryStellarVault("testnet"); const { service, input } = await enrollment(user.id, vault);
    await expect(service.registerPlayerVault(user.id, { ...input, deviceProofHex: "00".repeat(64) })).rejects.toMatchObject({ code: "vault_proof_invalid" });
    await expect(service.registerPlayerVault(other.user.id, input)).rejects.toMatchObject({ code: "vault_nonce_used" });
    await service.registerPlayerVault(user.id, input);
    await expect(service.registerPlayerVault(user.id, input)).rejects.toMatchObject({ code: "vault_nonce_used" });
  });
  it("rejects private-key/recovery-code fields and altered network/envelope metadata at the API boundary", async () => {
    const { user } = await account(); const vault = await createPrimaryStellarVault("testnet"); const { service, input } = await enrollment(user.id, vault);
    await expect(service.registerPlayerVault(user.id, { ...input, recoveryCode: "not-accepted" })).rejects.toMatchObject({ code: "invalid_vault" });
    await expect(service.registerPlayerVault(user.id, { ...input, publicVault: { ...input.publicVault, privateKey: "not-accepted" } })).rejects.toMatchObject({ code: "invalid_vault" });
    await expect(service.registerPlayerVault(user.id, { ...input, publicVault: { ...input.publicVault, network: "mainnet" } })).rejects.toMatchObject({ code: "vault_identity_mismatch" });
  });
  it("gates the verified Mainnet contract behind a later explicit approval", async () => {
    vi.stubEnv("STELLAR_NETWORK", "mainnet"); vi.stubEnv("STELLAR_VERIFICATION_VERSION", "1");
    vi.stubEnv("CHAIN_DUEL_VERIFIED_CONTRACT_ID", StrKey.encodeContract(new Uint8Array(32).fill(44))); vi.stubEnv("STELLAR_VERIFIED_WASM_HASH", "11".repeat(32)); vi.resetModules();
    const config = await import("@/lib/config/stellar-verification");
    expect(() => config.verifiedContractId()).toThrow("not been approved");
  });
});
