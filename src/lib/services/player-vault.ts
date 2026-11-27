import "server-only";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { db, nowIso } from "../db";
import { createWallet, findUserById, findWalletByAddress, primaryWallet, updateUser } from "../db/repositories/identity";
import { playerControlledSigningEnabled } from "../config/stellar-verification";
import { stellarNetwork } from "../config/stellar";
import { appUrl } from "../config/env";
import { STELLAR_DEPLOYMENT_ADMIN, type StellarNetworkId } from "../stellar/shared";
import type { PublicStellarVault, StellarVaultStatus, StellarVaultView } from "../wallet/vault-types";
import { vaultRegistrationMessage } from "../wallet/vault-types";
import { ChainDuelError } from "./errors";
import type { SqlDriver } from "../db/types";

const address = z.string().refine(value => StrKey.isValidEd25519PublicKey(value), "Invalid Stellar address");
const network = z.enum(["testnet", "mainnet", "futurenet", "local"]);
const kind = z.enum(["client-primary", "delegated-recovery"]);
const hex = (length: number) => z.string().regex(new RegExp(`^[0-9a-f]{${length * 2}}$`));
const envelopeSchema = z.object({ version: z.literal(1), algorithm: z.literal("HKDF-SHA256/AES-256-GCM"), walletAddress: address,
  signerAddress: address, publicKeyHex: hex(32), network, kind, saltHex: hex(16), nonceHex: hex(12),
  ciphertextBase64: z.string().min(60).max(4096).regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).strict();
export const publicVaultSchema = z.object({ version: z.literal(1), walletAddress: address, deviceSignerAddress: address,
  recoverySignerAddress: address, network, kind, recoveryEnvelope: envelopeSchema,
}).strict();

interface VaultRow { status: StellarVaultStatus; public_vault_json: string; approved_manifest_hash: string | null; verified_ledger: number | null }
export async function findPlayerVault(database: SqlDriver, walletId: string, networkId: StellarNetworkId): Promise<(VaultRow & { publicVault: PublicStellarVault }) | null> {
  const row = await database.one<VaultRow>("SELECT status,public_vault_json,approved_manifest_hash,verified_ledger FROM stellar_player_vaults WHERE wallet_id = ? AND network_id = ?", [walletId, networkId]);
  if (!row) return null;
  return { ...row, publicVault: publicVaultSchema.parse(JSON.parse(row.public_vault_json)) };
}
export async function playerVaultView(userId: string): Promise<StellarVaultView> {
  const database = await db(); const wallet = await primaryWallet(database, userId); const net = stellarNetwork();
  const vault = wallet ? await findPlayerVault(database, wallet.id, net.id) : null;
  return { enabled: playerControlledSigningEnabled(), walletAddress: wallet?.address ?? null, provider: wallet?.provider ?? null,
    custody: wallet?.custody ?? null, network: net.id, status: vault?.status ?? null, publicVault: vault?.publicVault ?? null };
}
function requireClientMode() {
  if (!playerControlledSigningEnabled()) throw new ChainDuelError("Player-controlled wallet setup is unavailable on this deployment.", "client_wallet_disabled", 409);
}
export async function createVaultChallenge(userId: string): Promise<{ nonce: string; message: string }> {
  requireClientMode(); const nonce = randomBytes(32).toString("hex"); const net = stellarNetwork();
  const message = ["Chain Duel — player-controlled wallet enrollment", `Domain: ${appUrl()}`, `Network: ${net.networkPassphrase}`, `User: ${userId}`, `Nonce: ${nonce}`].join("\n");
  await (await db()).execute("INSERT INTO stellar_vault_challenges(nonce,user_id,network_id,message,expires_at) VALUES(?,?,?,?,?)", [nonce, userId, net.id, message, new Date(Date.now() + 600000).toISOString()]);
  return { nonce, message };
}
export async function registerPlayerVault(userId: string, input: unknown): Promise<StellarVaultView> {
  requireClientMode();
  const request = z.object({ nonce: hex(32), publicVault: publicVaultSchema, deviceProofHex: hex(64), recoveryProofHex: hex(64) }).strict().safeParse(input);
  if (!request.success) throw new ChainDuelError("Only a valid public wallet and encrypted backup can be registered.", "invalid_vault", 422);
  const { nonce, publicVault, deviceProofHex, recoveryProofHex } = request.data;
  const envelope = publicVault.recoveryEnvelope; const net = stellarNetwork();
  if (publicVault.walletAddress === STELLAR_DEPLOYMENT_ADMIN || publicVault.network !== net.id || envelope.network !== net.id ||
    envelope.walletAddress !== publicVault.walletAddress || envelope.signerAddress !== publicVault.recoverySignerAddress ||
    StrKey.encodeEd25519PublicKey(Buffer.from(envelope.publicKeyHex, "hex")) !== envelope.signerAddress || envelope.kind !== publicVault.kind ||
    (publicVault.kind === "client-primary" && (publicVault.walletAddress !== publicVault.deviceSignerAddress || publicVault.walletAddress !== publicVault.recoverySignerAddress)) ||
    (publicVault.kind === "delegated-recovery" && (publicVault.deviceSignerAddress === publicVault.walletAddress || publicVault.recoverySignerAddress === publicVault.walletAddress || publicVault.deviceSignerAddress === publicVault.recoverySignerAddress))) {
    throw new ChainDuelError("The player wallet identities do not match the recovery backup.", "vault_identity_mismatch", 422);
  }
  const database = await db();
  await database.transaction(async tx => {
    const challenge = await tx.one<{ message: string; expires_at: string; consumed_at: string | null }>("SELECT message,expires_at,consumed_at FROM stellar_vault_challenges WHERE nonce = ? AND user_id = ? AND network_id = ?", [nonce, userId, net.id]);
    if (!challenge || challenge.consumed_at || challenge.expires_at < nowIso()) throw new ChainDuelError("Wallet enrollment expired or was already used.", "vault_nonce_used", 409);
    const bytes = vaultRegistrationMessage(challenge.message, publicVault);
    if (!Keypair.fromPublicKey(publicVault.deviceSignerAddress).verify(bytes, Buffer.from(deviceProofHex, "hex")) ||
      !Keypair.fromPublicKey(publicVault.recoverySignerAddress).verify(bytes, Buffer.from(recoveryProofHex, "hex"))) throw new ChainDuelError("The player-controlled signer proofs could not be verified.", "vault_proof_invalid", 422);
    const used = await tx.run("UPDATE stellar_vault_challenges SET consumed_at = ? WHERE nonce = ? AND consumed_at IS NULL", [nowIso(), nonce]);
    if (used !== 1) throw new ChainDuelError("Wallet enrollment was already used.", "vault_nonce_used", 409);
    if (tx.dialect === "postgres") await tx.query("SELECT id FROM users WHERE id = ? FOR UPDATE", [userId]);
    const user = await findUserById(tx, userId); let wallet = await primaryWallet(tx, userId);
    if (!user || !["google", "x", "demo"].includes(user.auth_provider)) throw new ChainDuelError("This wallet setup requires your existing social account.", "vault_account_mismatch", 403);
    if (publicVault.kind === "client-primary") {
      if (wallet || user.primary_wallet || await findWalletByAddress(tx, publicVault.walletAddress)) throw new ChainDuelError("An existing wallet must be recovered, never replaced.", "wallet_already_linked", 409);
      wallet = await createWallet(tx, { userId, address: publicVault.walletAddress, provider: "chain-duel-client", custody: "external", isPrimary: true, label: "Chain Duel wallet", network: net.id });
      await updateUser(tx, userId, { primary_wallet: publicVault.walletAddress });
    } else if (!wallet || wallet.address !== publicVault.walletAddress || wallet.custody !== "managed") {
      throw new ChainDuelError("The signer proposal must preserve your existing managed wallet address.", "wallet_migration_mismatch", 409);
    }
    if (await findPlayerVault(tx, wallet!.id, net.id)) throw new ChainDuelError("Recover the saved wallet before changing its signer proposal.", "vault_already_registered", 409);
    await tx.execute("INSERT INTO stellar_player_vaults(wallet_id,network_id,version,status,public_vault_json,created_at) VALUES(?,?,1,?,?,?)", [wallet!.id, net.id, publicVault.kind === "client-primary" ? "client-primary" : "awaiting-migration-review", JSON.stringify(publicVault), nowIso()]);
    // Deliberately no signer changes, key export, legacy-key lookup or custody fallback.
    // A backend session and key-possession proofs cannot approve legacy enrollment.
  });
  return playerVaultView(userId);
}
