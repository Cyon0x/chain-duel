import "server-only";
import { randomUUID } from "node:crypto";
import { parseUsdc, formatUsdc } from "../networks/arc";
import { ChainDuelError } from "../services/errors";
import { arcConfig } from "./config";
import { arcDb } from "./db";
import { arcWalletFor } from "./access";
import { createArcGame } from "./games";

interface Ticket {
  user_id: string;
  network_id: string;
  stake_units: string;
  status: string;
  game_id: string | null;
  expires_at: string;
  created_at: string;
}
export async function arcQueue(userId: string) {
  const database = await arcDb();
  const config = arcConfig();
  const ticket = await database.one<Ticket>("SELECT * FROM arc_queue WHERE user_id=? AND network_id=?", [
    userId,
    config.networkId,
  ]);
  if (!ticket) return { status: "idle", gameId: null };
  if (ticket.status === "matched" && ticket.game_id) {
    const game = await database.one<{ status: string }>("SELECT status FROM arc_games WHERE id=?", [
      ticket.game_id,
    ]);
    if (game && !["settled", "refunded"].includes(game.status))
      return { status: "matched", gameId: ticket.game_id };
    await database.execute(`DELETE FROM arc_queue WHERE user_id=? AND network_id=?`, [
      userId,
      config.networkId,
    ]);
    return { status: "idle", gameId: null };
  }
  if (new Date(ticket.expires_at).getTime() < Date.now()) return { status: "expired", gameId: null };
  return { status: ticket.status, gameId: ticket.game_id };
}
export async function joinArcQueue(userId: string, amount: string) {
  const config = arcConfig();
  if (!config.gamingEnabled)
    throw new ChainDuelError("Arc matchmaking is awaiting activation.", "arc_gaming_unavailable", 503);
  await arcWalletFor(userId);
  const database = await arcDb();
  const existing = await arcQueue(userId);
  if (existing.status === "matched") return existing;
  const units = parseUsdc(amount);
  if (units <= 0n) throw new ChainDuelError("Enter a positive USDC stake.", "invalid_stake", 422);
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 120_000).toISOString();
  await database.execute(
    `INSERT INTO arc_queue(user_id,network_id,currency,game_type,mode,stake_units,status,created_at,expires_at)
    VALUES(?,?,'USDC','pulse','pvp',?,'searching',?,?) ON CONFLICT(user_id,network_id) DO UPDATE SET stake_units=excluded.stake_units,
    status='searching',created_at=excluded.created_at,expires_at=excluded.expires_at,game_id=NULL WHERE arc_queue.status <> 'pairing' OR arc_queue.expires_at < excluded.created_at`,
    [userId, config.networkId, units.toString(), now, expires],
  );
  const rival = await database.one<Ticket>(
    `SELECT * FROM arc_queue WHERE network_id=? AND currency='USDC' AND game_type='pulse' AND mode='pvp'
    AND stake_units=? AND status='searching' AND user_id<>? AND expires_at>? ORDER BY created_at LIMIT 1`,
    [config.networkId, units.toString(), userId, now],
  );
  if (!rival) return arcQueue(userId);
  const claimed = await database.transaction(async (tx) => {
    const a = await tx.run(
      `UPDATE arc_queue SET status='pairing' WHERE user_id=? AND network_id=? AND status='searching' AND stake_units=?`,
      [rival.user_id, config.networkId, units.toString()],
    );
    if (!a) return false;
    const b = await tx.run(
      `UPDATE arc_queue SET status='pairing' WHERE user_id=? AND network_id=? AND status='searching' AND stake_units=?`,
      [userId, config.networkId, units.toString()],
    );
    if (!b) {
      await tx.execute(
        `UPDATE arc_queue SET status='searching' WHERE user_id=? AND network_id=? AND status='pairing'`,
        [rival.user_id, config.networkId],
      );
      return false;
    }
    return true;
  });
  if (!claimed) return arcQueue(userId);
  try {
    const game = await createArcGame({
      userId: rival.user_id,
      opponentId: userId,
      mode: "pvp",
      amount: formatUsdc(units),
      requestKey: randomUUID(),
    });
    await database.execute(
      `UPDATE arc_queue SET status='matched',game_id=? WHERE network_id=? AND user_id IN (?,?) AND status='pairing'`,
      [game.id, config.networkId, userId, rival.user_id],
    );
    return { status: "matched", gameId: game.id };
  } catch (error) {
    await database.execute(
      `UPDATE arc_queue SET status='searching' WHERE network_id=? AND user_id IN (?,?) AND status='pairing'`,
      [config.networkId, userId, rival.user_id],
    );
    throw error;
  }
}
export async function leaveArcQueue(userId: string) {
  const state = await arcQueue(userId);
  if (state.status === "pairing" || state.status === "matched")
    throw new ChainDuelError("A duel is being prepared. Open it to manage your entry.", "queue_matched", 409);
  await (
    await arcDb()
  ).execute("DELETE FROM arc_queue WHERE user_id=? AND network_id=?", [userId, arcConfig().networkId]);
  return { status: "idle", gameId: null };
}
