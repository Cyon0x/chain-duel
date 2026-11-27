import "server-only";
import { createHash } from "node:crypto";
import type { SqlDriver } from "../db/types";
import { createTransaction } from "../db/repositories/economy";
import { explorerTxUrl, stellarNetwork } from "../config/stellar";
import { STELLAR_MAINNET_USDC_ISSUER, STELLAR_TESTNET_USDC_ISSUER, type StellarAssetSymbol, type StellarNetworkId } from "../stellar/shared";
import { decimalUnits } from "../stellar/payments";

interface HorizonPayment {
  id: string; type: string; to?: string; account?: string; from?: string; funder?: string;
  amount?: string; starting_balance?: string; asset_type?: string; asset_code?: string; asset_issuer?: string;
  transaction_hash: string; transaction_successful: boolean; created_at: string;
}

/** Incoming classic deposits are reconciled from successful Horizon operations.
 * One operation has one stable ledger id. Game payouts already booked by the
 * settlement service remain a single receipt in player history. */
export async function syncMainnetWalletDeposits(database: SqlDriver, userId: string, address: string, network: StellarNetworkId = "mainnet") {
  const net = stellarNetwork(network);
  const response = await fetch(`${net.horizonUrl}/accounts/${address}/payments?order=desc&limit=50`, { cache: "no-store", signal: AbortSignal.timeout(10000) });
  if (response.status === 404) return;
  if (!response.ok) throw new Error("Wallet deposit history is unavailable.");
  const page = await response.json() as { _embedded?: { records?: HorizonPayment[] } };
  for (const operation of page._embedded?.records ?? []) {
    if (operation.transaction_successful !== true || !/^[0-9a-f]{64}$/.test(operation.transaction_hash) || (operation.to ?? operation.account) !== address) continue;
    let currency: StellarAssetSymbol;
    if (operation.type === "create_account" || operation.asset_type === "native") currency = "XLM";
    else if (operation.type === "payment" && operation.asset_code === "USDC" && operation.asset_issuer === (network === "mainnet" ? STELLAR_MAINNET_USDC_ISSUER : STELLAR_TESTNET_USDC_ISSUER)) currency = "USDC";
    else continue;
    const units = decimalUnits(operation.amount ?? operation.starting_balance ?? "0");
    if (units <= 0n || units > BigInt(Number.MAX_SAFE_INTEGER)) continue;
    if (await database.one("SELECT id FROM transactions WHERE user_id = ? AND tx_hash = ? AND direction = 'in' AND kind IN ('payout','treasury_withdrawal')", [userId, operation.transaction_hash])) continue;
    const id = `txn_horizon_${createHash("sha256").update(`${network}:${userId}:${operation.id}`).digest("hex")}`;
    await createTransaction(database, { id, userId, kind: "deposit", direction: "in", amountStroops: Number(units), status: "confirmed", txHash: operation.transaction_hash, explorerUrl: explorerTxUrl(operation.transaction_hash, network), address, stellarNetwork: network, currency, metadata: { source: operation.from ?? operation.funder, horizonOperationId: operation.id, onChainCreatedAt: operation.created_at } });
  }
}
