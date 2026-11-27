"use client";
import type { MatchView } from "../api/views";
import { buildTargetSchedule, theoreticalMaxScore } from "../game/pulse";
import { readDirectPulseState } from "./verified-pulse";
import { STELLAR_DEPLOYMENT_ADMIN } from "../stellar/shared";
import { stellarPoolSplit } from "../stellar/shared";

/** Gameplay and final payout display use independent chain state, not API scores. */
export async function independentlyVerifiedMatchView(view: MatchView): Promise<MatchView> {
  if (view.game.demo || view.game.verification_version !== 1 || ["none", "offchain"].includes(view.game.escrow_state)) return view;
  const actual = await readDirectPulseState(view.game);
  const first = view.players.find(player => player.seat === 1); const second = view.players.find(player => player.seat === 2);
  if (!first || actual.creator !== first.address || (actual.mode === 0 && actual.opponent && actual.opponent !== second?.address)) throw new Error("The independently verified seats differ from this duel's player wallets.");
  const schedule = buildTargetSchedule(actual.seedHex, 60000);
  if (actual.status === 4) {
    const split = stellarPoolSplit(view.game.entry_stroops * 2, 500, 500);
    const firstWon = actual.playerOneScore > actual.playerTwoScore || (actual.playerOneScore === actual.playerTwoScore && actual.playerOneCombo >= actual.playerTwoCombo);
    const winner = firstWon ? first : second;
    if (!winner || actual.winner !== (winner.is_bot ? STELLAR_DEPLOYMENT_ADMIN : winner.address) || actual.payout !== String(split.payout) || actual.protocolFee !== String(split.protocol) || actual.ecosystemFee !== String(split.ecosystem)) throw new Error("The contract result or fee allocation does not match the independently verified game.");
    return { ...view, schedule, serverTimeMs: Date.now(), startAtMs: actual.startedAtMs, countdownMs: 3200,
      game: { ...view.game, seed: actual.seedHex, duration_ms: 60000, status: "settled", settlement_status: "confirmed", escrow_state: "settled", winner_id: winner.is_bot ? null : winner.user_id,
        player_one_score: actual.playerOneScore, player_two_score: actual.playerTwoScore, payout_stroops: split.payout, fee_stroops: split.fee, protocol_fee_stroops: split.protocol, ecosystem_fee_stroops: split.ecosystem, result_hash: actual.resultHash },
      players: view.players.map(player => ({ ...player, score: player.seat === 1 ? actual.playerOneScore : actual.playerTwoScore, max_combo: player.seat === 1 ? actual.playerOneCombo : actual.playerTwoCombo })) };
  }
  return { ...view, schedule, maxScore: theoreticalMaxScore(schedule), serverTimeMs: Date.now(), startAtMs: actual.status === 2 ? actual.startedAtMs : null, countdownMs: 3200,
    game: { ...view.game, seed: actual.seedHex, duration_ms: 60000, started_at: actual.status === 2 ? new Date(actual.startedAtMs).toISOString() : null, status: actual.status === 2 ? "active" : actual.status === 1 ? "joined" : actual.status === 5 ? "cancelled" : actual.status === 6 ? "expired" : "waiting" },
  };
}
