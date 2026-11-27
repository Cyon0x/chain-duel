import { fail, ok } from "@/lib/api/respond";
import { requireSessionUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { findPlayerVault } from "@/lib/services/player-vault";
import { playerControlledSigningEnabled } from "@/lib/config/stellar-verification";
import { stellarNetwork } from "@/lib/config/stellar";
import { baseReserveUnits, decimalUnits } from "@/lib/stellar/payments";
import { preparePlayerSignerMigration } from "@/lib/wallet/migration-plan";
import { ChainDuelError } from "@/lib/services/errors";
import type { StellarAccountAuthority } from "@/lib/stellar/player-authority";

export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const session = await requireSessionUser(); const wallet = session.primaryWallet; const network = stellarNetwork(); const database = await db();
    if (!playerControlledSigningEnabled() || !wallet) throw new ChainDuelError("Player signer migration preparation is unavailable.", "migration_plan_unavailable", 409);
    const vault = await findPlayerVault(database, wallet.id, network.id);
    if (!vault || vault.status !== "awaiting-migration-review") throw new ChainDuelError("Prepare your player-controlled signer proposal before requesting its migration plan.", "migration_proposal_missing", 409);
    const response = await fetch(`${network.horizonUrl}/accounts/${wallet.address}`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new ChainDuelError("The original player account must be funded before its signer migration can be prepared.", "migration_account_unavailable", 409);
    const account = await response.json() as StellarAccountAuthority & { balances: { asset_type: string; balance: string; selling_liabilities?: string }[]; num_sponsoring: number; num_sponsored: number };
    const native = account.balances.find(balance => balance.asset_type === "native");
    const games = await database.one<{ count: number }>("SELECT COUNT(*) AS count FROM games WHERE stellar_network = ? AND demo = 0 AND (creator_id = ? OR opponent_id = ?) AND status NOT IN ('settled','cancelled','expired','refunded')", [network.id, session.user.id, session.user.id]);
    const pending = await database.one<{ count: number }>("SELECT COUNT(*) AS count FROM transactions WHERE user_id = ? AND stellar_network = ? AND demo = 0 AND status NOT IN ('confirmed','failed','cancelled')", [session.user.id, network.id]);
    return ok(await preparePlayerSignerMigration(account, vault.publicVault, network.id, { baseReserveUnits: await baseReserveUnits(network.id), nativeBalanceUnits: decimalUnits(native?.balance ?? "0"), sellingLiabilitiesUnits: decimalUnits(native?.selling_liabilities ?? "0"), numSponsoring: account.num_sponsoring ?? 0, numSponsored: account.num_sponsored ?? 0, activeGames: Number(games?.count ?? 0), pendingTransactions: Number(pending?.count ?? 0) }));
  } catch (error) { return fail(error); }
}
