import { ok } from "@/lib/api/respond";
import { arcFail as fail } from "@/lib/arc/respond";
import { arcSession } from "@/lib/arc/access";
import { associatedArcWallet } from "@/lib/arc/circle";
import { arcBalance } from "@/lib/arc/chain";
import { publicArcConfig } from "@/lib/arc/config";
import { arcDb } from "@/lib/arc/db";
import type { Address } from "viem";
export async function GET() {
  try {
    const session = await arcSession();
    const wallet = await associatedArcWallet(session.user.id);
    let balance = null;
    let balanceError = null;
    if (wallet?.address) {
      try {
        balance = await arcBalance(wallet.address as Address);
      } catch {
        balanceError = "USDC balance is temporarily unavailable.";
      }
    }
    const config = publicArcConfig();
    const transactions = await (
      await arcDb()
    ).query(
      "SELECT * FROM arc_transactions WHERE user_id=? AND network_id=? ORDER BY created_at DESC LIMIT 50",
      [session.user.id, config.networkId],
    );
    return ok({
      config,
      wallet: wallet
        ? { address: wallet.address, status: wallet.status, provider: wallet.provider, error: wallet.error }
        : null,
      balance,
      balanceError,
      transactions,
    });
  } catch (error) {
    return fail(error);
  }
}
