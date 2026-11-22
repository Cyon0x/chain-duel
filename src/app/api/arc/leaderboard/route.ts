import { ok } from "@/lib/api/respond";
import { arcFail as fail } from "@/lib/arc/respond";
import { arcDb } from "@/lib/arc/db";
import { arcConfig } from "@/lib/arc/config";
export async function GET() {
  try {
    const players = await (
      await arcDb()
    ).query(
      `SELECT p.username, COUNT(*) AS games, SUM(CASE WHEN g.winner_id = a.user_id THEN 1 ELSE 0 END) AS wins FROM arc_players a JOIN arc_games g ON g.id=a.game_id JOIN profiles p ON p.user_id=a.user_id
  WHERE g.network_id=? AND g.status='settled' AND g.mode <> 'bot' GROUP BY p.username ORDER BY wins DESC,games DESC,p.username LIMIT 50`,
      [arcConfig().networkId],
    );
    return ok({ players });
  } catch (error) {
    return fail(error);
  }
}
