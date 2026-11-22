import { ok, fail } from "@/lib/api/respond";
import { requireSessionUser } from "@/lib/auth/session";
import { arcDb } from "@/lib/arc/db";
export async function GET() {
  try {
    const userId = (await requireSessionUser()).user.id;
    const database = await arcDb();
    const stellar = await database.query(
      `SELECT t.*, 'stellar-' || COALESCE((SELECT w.network FROM wallets w WHERE w.user_id=t.user_id ORDER BY w.is_primary DESC LIMIT 1),'unknown') AS network_id,
        'XLM' AS currency, 7 AS token_decimals FROM transactions t WHERE t.user_id=? ORDER BY t.created_at DESC LIMIT 100`,
      [userId],
    );
    const arc = await database.query(
      "SELECT * FROM arc_transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 100",
      [userId],
    );
    return ok({ stellar, arc });
  } catch (error) {
    return fail(error);
  }
}
