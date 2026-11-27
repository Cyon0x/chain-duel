import "server-only";
import { db } from "../db";
import { createTransaction, listAdminActions, listTreasuryTransactions, recordAdminAction, recordTreasuryTransaction } from "../db/repositories/economy";
import { botMatchTotals, listBotMatches } from "../db/repositories/duel";
import { rawEnv } from "../config/env";
import { contractId, explorerTxUrl, stellarNetwork, tokenContractId, publicStellarConfig } from "../config/stellar";
import { stellarVerificationEnabled } from "../config/stellar-verification";
import { STELLAR_DEPLOYMENT_ADMIN } from "../stellar/shared";
import { createHash } from "node:crypto";
import { hasStellarIntent } from "../stellar/intents";
import { onChainEscrowAvailable, treasurySnapshot } from "./escrow";
import { getOnChainConfig, serverWithdrawFees, serverWithdrawTreasury } from "../stellar/contract";
import { settlementPublicKey } from "../stellar/server";
import { signerForUser } from "../wallet/signer";
import { ChainDuelError } from "./errors";
import { TREASURY_LIMITS, stroopsToXlm } from "../config/game";

// Admin authorisation is enforced in layers:
//   1. the session must be authenticated and own the designated admin wallet;
//   2. the server-side settlement key must match the contract's admin;
//   3. the Soroban contract calls require_admin(caller) and only ever pays the
//      bound treasury address.
// A frontend-only check is never sufficient, and none is relied upon here.

export async function adminWalletAddress(): Promise<string | null> {
  const configured = rawEnv().ADMIN_WALLET_ADDRESS?.trim();
  if (stellarNetwork().id === "mainnet") return configured === STELLAR_DEPLOYMENT_ADMIN ? configured : null;
  if (configured) return configured;
  if (!contractId()) return null;
  try {
    const { getOnChainConfig } = await import("../stellar/contract");
    return (await getOnChainConfig())?.admin ?? null;
  } catch {
    return null;
  }
}

export async function isAdmin(userId: string): Promise<boolean> {
  const signer = await signerForUser(userId);
  const admin = await adminWalletAddress();
  return Boolean(signer && admin && signer.address === admin);
}

export async function requireAdmin(userId: string): Promise<string> {
  const signer = await signerForUser(userId);
  const admin = await adminWalletAddress();
  if (!signer || !admin || signer.address !== admin) {
    throw new ChainDuelError(
      "Only the designated Chain Duel administrator can do that.",
      "forbidden",
      403,
    );
  }
  return admin;
}

export interface TreasuryDashboard {
  contractConfigured: boolean;
  contractId: string | null;
  escrowAvailable: boolean;
  adminWallet: string | null;
  settlementKeyMatchesAdmin: boolean;
  snapshot: Awaited<ReturnType<typeof treasurySnapshot>>;
  totals: Awaited<ReturnType<typeof botMatchTotals>>;
  botMatches: Awaited<ReturnType<typeof listBotMatches>>;
  treasuryTransactions: Awaited<ReturnType<typeof listTreasuryTransactions>>;
  adminActions: Awaited<ReturnType<typeof listAdminActions>>;
  limits: typeof TREASURY_LIMITS;
}

export async function treasuryDashboard(): Promise<TreasuryDashboard> {
  const database = await db();
  const admin = await adminWalletAddress();
  const snapshot = await treasurySnapshot().catch(() => null);
  const settlementKey = settlementPublicKey();
  const [totals, botMatches, treasuryTransactions, adminActions] = await Promise.all([
    botMatchTotals(database),
    listBotMatches(database, 25),
    listTreasuryTransactions(database, 25),
    listAdminActions(database, 25),
  ]);
  return {
    contractConfigured: Boolean(contractId()),
    contractId: contractId(),
    escrowAvailable: onChainEscrowAvailable(),
    adminWallet: admin,
    settlementKeyMatchesAdmin: Boolean(admin && settlementKey && admin === settlementKey),
    snapshot:
      snapshot ??
      ({
        available: false,
        botLiquidityStroops: 0,
        accruedFeesStroops: 0,
        lockedEscrowStroops: 0,
        contractBalanceStroops: 0,
        paused: false,
        botEnabled: false,
        adminAddress: null,
        treasuryAddress: null,
        maxEntryStroops: 0,
        maxPayoutStroops: 0,
        minTreasuryBalanceStroops: 0,
        stats: null,
      } as Awaited<ReturnType<typeof treasurySnapshot>>),
    totals,
    botMatches,
    treasuryTransactions,
    adminActions,
    limits: TREASURY_LIMITS,
  };
}

export async function withdrawTreasury(input: {
  userId: string;
  amountStroops: number;
  kind?: "protocol" | "ecosystem";
  requestId?: string;
  networkId?: string;
  currency?: string;
}): Promise<{ txHash: string; explorerUrl: string; remaining: string }> {
  const admin = await requireAdmin(input.userId);
  if (!onChainEscrowAvailable()) {
    throw new ChainDuelError("Treasury withdrawals require a configured contract.", "not_configured", 503);
  }
  if (!Number.isSafeInteger(input.amountStroops) || input.amountStroops <= 0) {
    throw new ChainDuelError("Enter a valid withdrawal amount.", "invalid_amount");
  }
  if (stellarNetwork().id === "mainnet" || stellarVerificationEnabled()) return withdrawAllocatedFees(input, admin);
  const snapshot = await treasurySnapshot();
  if (input.amountStroops > snapshot.accruedFeesStroops) {
    throw new ChainDuelError(
      "That is more than the accrued protocol revenue available to withdraw.",
      "insufficient_treasury",
    );
  }

  const result = await serverWithdrawTreasury(input.amountStroops);
  await recordAdminAction(await db(), {
    adminWallet: admin,
    action: "treasury_withdrawal",
    target: snapshot.treasuryAddress ?? admin,
    payload: { amountStroops: input.amountStroops },
    txHash: result.hash,
  });
  return {
    txHash: result.hash,
    explorerUrl: explorerTxUrl(result.hash),
    remaining: stroopsToXlm(snapshot.accruedFeesStroops - input.amountStroops).toFixed(2),
  };
}

async function withdrawAllocatedFees(input: { userId: string; amountStroops: number; kind?: "protocol" | "ecosystem"; requestId?: string; networkId?: string; currency?: string }, admin: string) {
  const network = stellarNetwork().id; const currency = publicStellarConfig().asset.symbol;
  if (input.currency !== currency || input.networkId !== `stellar-${network}` || !input.requestId || !/^[A-Za-z0-9_-]{8,100}$/.test(input.requestId)) throw new ChainDuelError("Prepare this fee withdrawal again with its Stellar network, asset and request id.", "financial_context_required", 409);
  const kind = input.kind ?? "protocol";
  if (!["protocol", "ecosystem"].includes(kind)) throw new ChainDuelError("Choose a valid fee allocation.", "invalid_input");
  const withdrawalId = createHash("sha256").update(`stellar-${network}-fee:${input.userId}:${kind}:${input.requestId}`).digest("hex");
  const database = await db();
  const booked = await database.one<{ amount_units: number; allocation: string; tx_hash: string }>("SELECT amount_units,allocation,tx_hash FROM stellar_fee_withdrawals WHERE request_id = ?", [withdrawalId]);
  if (booked && (Number(booked.amount_units) !== input.amountStroops || booked.allocation !== kind)) throw new ChainDuelError("That withdrawal request was already used with different parameters.", "intent_mismatch", 409);
  if (booked) return { txHash: booked.tx_hash, explorerUrl: explorerTxUrl(booked.tx_hash), remaining: "See refreshed fee balance" };
  const config = await getOnChainConfig();
  if (!config || admin !== STELLAR_DEPLOYMENT_ADMIN || config.admin !== admin || config.treasury !== admin || config.protocolFeeRecipient !== admin || config.ecosystemFeeRecipient !== admin || config.ecosystemBeneficiary !== admin || config.token !== tokenContractId(network) || settlementPublicKey() !== admin) throw new ChainDuelError("The designated Stellar fee collector configuration could not be verified.", "not_configured", 503);
  const snapshot = await treasurySnapshot();
  const available = kind === "ecosystem" ? snapshot.ecosystemFeesStroops ?? 0 : snapshot.protocolFeesStroops ?? 0;
  // The contract repeats the amount and liability checks atomically. A saved
  // signing intent is resolved first on retries, even after its fee bucket fell.
  const intent = await hasStellarIntent(`stellar-fee:${kind}:${withdrawalId}`, network);
  if (!intent && input.amountStroops > available) throw new ChainDuelError("That exceeds the selected fee allocation available to withdraw.", "insufficient_treasury");
  const result = await serverWithdrawFees({ kind, amountStroops: input.amountStroops, withdrawalId });
  await database.transaction(async tx => {
    const inserted = await tx.run("INSERT INTO stellar_fee_withdrawals(request_id,user_id,allocation,amount_units,tx_hash,booked_at) VALUES(?,?,?,?,?,?) ON CONFLICT(request_id) DO NOTHING", [withdrawalId, input.userId, kind, input.amountStroops, result.hash, new Date().toISOString()]);
    if (!inserted) return;
    await recordAdminAction(tx, { adminWallet: admin, action: `${kind}_fee_withdrawal`, target: admin, payload: { withdrawalId, amountStroops: input.amountStroops, currency, network }, txHash: result.hash });
    await recordTreasuryTransaction(tx, { kind: `${kind}_fee_withdrawal`, direction: "out", amountStroops: input.amountStroops, txHash: result.hash, actor: admin, stellarNetwork: network, currency, metadata: { allocation: kind, recipient: admin, withdrawalId } });
    await createTransaction(tx, { id: `txn_fee_${withdrawalId}`, userId: input.userId, kind: "treasury_withdrawal", direction: "in", amountStroops: input.amountStroops, status: "confirmed", address: admin, txHash: result.hash, explorerUrl: explorerTxUrl(result.hash), stellarNetwork: network, currency, allocation: kind });
  });
  const fresh = await treasurySnapshot();
  return { txHash: result.hash, explorerUrl: explorerTxUrl(result.hash), remaining: stroopsToXlm(kind === "ecosystem" ? fresh.ecosystemFeesStroops ?? 0 : fresh.protocolFeesStroops ?? 0).toFixed(7) };
}
