import "server-only";
import type { ProfileRow, SqlDriver } from "../types";
import { stellarNetwork, publicStellarConfig } from "../../config/stellar";
import { financialNetwork, financialSymbol, type StellarFinancialContext } from "../../stellar/shared";

export async function recordStellarProfileFinance(database: SqlDriver, userId: string, game: StellarFinancialContext, earned: number, wagered: number, feePaid: number) {
  await database.execute(`INSERT INTO stellar_profile_finance(user_id,stellar_network,currency,total_earned_stroops,total_wagered_stroops,fees_paid_stroops)
    VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,stellar_network,currency) DO UPDATE SET
    total_earned_stroops = stellar_profile_finance.total_earned_stroops + excluded.total_earned_stroops,
    total_wagered_stroops = stellar_profile_finance.total_wagered_stroops + excluded.total_wagered_stroops,
    fees_paid_stroops = stellar_profile_finance.fees_paid_stroops + excluded.fees_paid_stroops`,
  [userId, financialNetwork(game), financialSymbol(game), earned, wagered, Math.floor(feePaid)]);
}

export async function profileWithCurrentFinance(database: SqlDriver, profile: ProfileRow): Promise<ProfileRow & StellarFinancialContext> {
  const network = stellarNetwork().id;
  const currency = publicStellarConfig().asset.symbol;
  if (network !== "mainnet" && currency === "XLM") return { ...profile, stellar_network: network, currency };
  const totals = await database.one<{ total_earned_stroops: number; total_wagered_stroops: number; fees_paid_stroops: number }>("SELECT total_earned_stroops,total_wagered_stroops,fees_paid_stroops FROM stellar_profile_finance WHERE user_id = ? AND stellar_network = ? AND currency = ?", [profile.user_id, network, currency]);
  return { ...profile, total_earned_stroops: Number(totals?.total_earned_stroops ?? 0), total_wagered_stroops: Number(totals?.total_wagered_stroops ?? 0), fees_paid_stroops: Number(totals?.fees_paid_stroops ?? 0), stellar_network: network, currency };
}
