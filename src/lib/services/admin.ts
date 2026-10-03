import "server-only";
import { db } from "../db";
import { listAdminActions, listTreasuryTransactions, recordAdminAction } from "../db/repositories/economy";
import { botMatchTotals, listBotMatches } from "../db/repositories/duel";
import { rawEnv } from "../config/env";
import { contractId, explorerTxUrl } from "../config/stellar";
import { onChainEscrowAvailable, treasurySnapshot } from "./escrow";
import { serverWithdrawTreasury } from "../stellar/contract";
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
}): Promise<{ txHash: string; explorerUrl: string; remaining: string }> {
  const admin = await requireAdmin(input.userId);
  if (!onChainEscrowAvailable()) {
    throw new ChainDuelError("Treasury withdrawals require a configured contract.", "not_configured", 503);
  }
  if (!Number.isInteger(input.amountStroops) || input.amountStroops <= 0) {
    throw new ChainDuelError("Enter a valid withdrawal amount.", "invalid_amount");
  }
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
