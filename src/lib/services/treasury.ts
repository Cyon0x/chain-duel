import "server-only";
import { db } from "../db";
import { botLiabilitySince, recordTreasuryTransaction } from "../db/repositories/economy";
import { botMatchTotals } from "../db/repositories/duel";
import type { SqlDriver } from "../db/types";
import type { StellarAssetSymbol, StellarNetworkId } from "../stellar/shared";
import { ECONOMY, TREASURY_LIMITS, splitPool } from "../config/game";
import { onChainEscrowAvailable, treasurySnapshot } from "./escrow";
import { publicStellarConfig, stellarGamingAllowed } from "../config/stellar";

export interface BotAvailability {
  available: boolean;
  reason?: string;
  botLiquidityStroops: number;
  dailyLiabilityStroops: number;
  maxDailyLiabilityStroops: number;
}

/**
 * Pre-flight check before a computer match may be created. Mirrors the limits
 * the contract enforces on chain so we never start a game we cannot settle.
 */
export async function botAvailability(entryStroops: number, userId?: string): Promise<BotAvailability> {
  const limits = TREASURY_LIMITS;
  const base = {
    botLiquidityStroops: 0,
    dailyLiabilityStroops: 0,
    maxDailyLiabilityStroops: limits.dailyBotLiabilityStroops,
  };
  if (!Number.isSafeInteger(entryStroops) || entryStroops < ECONOMY.minEntryStroops || entryStroops > ECONOMY.maxEntryStroops) {
    return { ...base, available: false, reason: `Entry must be between 25 and 10,000 ${publicStellarConfig().asset.symbol} per player.` };
  }
  if (!stellarGamingAllowed(userId)) return { ...base, available: false, reason: "Stellar staked duels are temporarily paused." };

  if (!onChainEscrowAvailable()) {
    return { ...base, available: false, reason: "Computer matches need the escrow contract to be configured." };
  }

  const snapshot = await treasurySnapshot();
  if (!snapshot.available) {
    return { ...base, available: false, reason: "Computer matches are temporarily unavailable." };
  }
  if (snapshot.paused) {
    return { ...base, available: false, reason: "Chain Duel is paused while we perform maintenance." };
  }
  if (!snapshot.botEnabled) {
    return { ...base, available: false, reason: "Computer matches are temporarily unavailable." };
  }
  if (entryStroops > Math.min(limits.maxBotEntryStroops, snapshot.maxEntryStroops)) {
    return { ...base, available: false, reason: "That entry is above the computer-match limit." };
  }

  const potentialPayout = splitPool(entryStroops * 2, ECONOMY.feeBps).payout;
  if (potentialPayout > Math.min(limits.maxPayoutStroops, snapshot.maxPayoutStroops)) {
    return { ...base, available: false, reason: "That entry exceeds the maximum payout limit." };
  }

  const database = await db();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const liability = await botLiabilitySince(database, since);
  const worstCaseLoss = entryStroops;
  if (liability + worstCaseLoss > limits.dailyBotLiabilityStroops) {
    return {
      ...base,
      botLiquidityStroops: snapshot.botLiquidityStroops,
      dailyLiabilityStroops: liability,
      available: false,
      reason: "Computer matches are temporarily unavailable.",
    };
  }

  if (snapshot.botLiquidityStroops < entryStroops) {
    return {
      ...base,
      botLiquidityStroops: snapshot.botLiquidityStroops,
      dailyLiabilityStroops: liability,
      available: false,
      reason: "Computer matches are temporarily unavailable.",
    };
  }

  if (snapshot.botLiquidityStroops - entryStroops < limits.minTreasuryBalanceStroops) {
    return {
      ...base,
      botLiquidityStroops: snapshot.botLiquidityStroops,
      dailyLiabilityStroops: liability,
      available: false,
      reason: "Computer matches are temporarily unavailable.",
    };
  }

  return {
    available: true,
    botLiquidityStroops: snapshot.botLiquidityStroops,
    dailyLiabilityStroops: liability,
    maxDailyLiabilityStroops: limits.dailyBotLiabilityStroops,
  };
}

export async function recordBotTreasuryMovement(input: {
  kind: "bot_settlement" | "fee_accrual" | "bot_funding";
  direction: "in" | "out";
  amountStroops: number;
  txHash: string | null;
  gameId: string | null;
  actor?: string | null;
  balanceAfterStroops?: number | null;
  metadata?: unknown;
  stellarNetwork?: StellarNetworkId;
  currency?: StellarAssetSymbol;
}, driver?: SqlDriver): Promise<void> {
  const database = driver ?? (await db());
  await recordTreasuryTransaction(database, {
    kind: input.kind,
    direction: input.direction,
    amountStroops: input.amountStroops,
    txHash: input.txHash,
    gameId: input.gameId,
    actor: input.actor ?? null,
    balanceAfterStroops: input.balanceAfterStroops ?? null,
    metadata: input.metadata,
    stellarNetwork: input.stellarNetwork,
    currency: input.currency,
  });
}

export async function treasuryAccounting() {
  const database = await db();
  const [totals, snapshot] = await Promise.all([botMatchTotals(database), treasurySnapshot()]);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const dailyLiability = await botLiabilitySince(database, since);
  return {
    totals,
    snapshot,
    dailyLiabilityStroops: dailyLiability,
    limits: TREASURY_LIMITS,
  };
}
