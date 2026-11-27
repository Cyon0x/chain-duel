import "server-only";
import { db } from "../db";
import { primaryWallet } from "../db/repositories/identity";
import { stellarNetwork } from "../config/stellar";
import type { StellarNetworkId } from "../stellar/shared";
import { delegatedPlayerAuthority, type StellarAccountAuthority } from "../stellar/player-authority";
import { findPlayerVault } from "./player-vault";
import { ChainDuelError } from "./errors";

export async function readPlayerAccountAuthority(address: string, network: StellarNetworkId): Promise<StellarAccountAuthority | null> {
  const response = await fetch(`${stellarNetwork(network).horizonUrl}/accounts/${address}`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new ChainDuelError("Current Stellar signing authority could not be verified.", "player_authority_unavailable", 503);
  const account = await response.json() as StellarAccountAuthority;
  if (account.account_id !== address || !Array.isArray(account.signers)) throw new ChainDuelError("Stellar returned a different player account.", "player_authority_mismatch", 503);
  return account;
}
export async function assertPlayerWalletReady(userId: string, address: string, network: StellarNetworkId): Promise<void> {
  const database = await db(); const wallet = await primaryWallet(database, userId);
  if (!wallet || wallet.address !== address) throw new ChainDuelError("Reconnect the original staking wallet.", "player_wallet_mismatch", 409);
  if (wallet.custody !== "managed" && wallet.provider !== "chain-duel-client") return;
  const vault = await findPlayerVault(database, wallet.id, network);
  if (wallet.custody === "managed") {
    if (!vault || vault.status !== "client-delegated" || !/^[0-9a-f]{64}$/.test(vault.approved_manifest_hash ?? "")) throw new ChainDuelError("Your existing wallet's player-controlled signers require migration review before verified stakes are enabled.", "player_migration_review_pending", 409);
    const account = await readPlayerAccountAuthority(address, network);
    if (!account || !delegatedPlayerAuthority(account, vault.publicVault)) throw new ChainDuelError("The old wallet signing authority has not been independently revoked.", "player_authority_not_migrated", 409);
  } else if (!vault || vault.status !== "client-primary" || vault.publicVault.walletAddress !== address) {
    throw new ChainDuelError("Restore your player-controlled wallet before staking.", "client_vault_missing", 409);
  }
}
