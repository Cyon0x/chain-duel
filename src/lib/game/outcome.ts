/**
 * Single source of truth for "what happened in this duel", shared by every
 * result surface.
 *
 * `winner_id` is written by settlement inside the same transaction that marks a
 * game `settled`, so it is only meaningful once settlement has fully confirmed.
 * Before that, the game row briefly carries `status: "finished"` with no winner
 * yet — reading it there is what used to render a loss as "DRAW". Everything
 * that shows a result must gate on `isResultFinal` first.
 */

export type DuelOutcome = "win" | "loss" | "draw" | "pending";

export interface OutcomeGame {
  status: string;
  settlement_status?: string | null;
  winner_id: string | null;
  mode: string;
}

/** True only once the server has written the authoritative result. */
export function isResultFinal(game: Pick<OutcomeGame, "status" | "settlement_status">): boolean {
  if (game.status === "settled") return true;
  return game.status === "finished" && game.settlement_status === "confirmed";
}

/** Derives the viewer's outcome from authoritative game state. */
export function resolveOutcome(game: OutcomeGame, selfUserId: string | null): DuelOutcome {
  if (!isResultFinal(game)) return "pending";
  if (selfUserId && game.winner_id === selfUserId) return "win";
  if (game.winner_id !== null) return "loss";
  // No human winner recorded: either the computer won, or nobody did.
  return game.mode === "bot" ? "loss" : "draw";
}
