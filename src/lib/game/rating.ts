import { RATING } from "../config/game";

/** Classic Elo. Only human-vs-human duels are rated. */
export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

export function eloDelta(ratingA: number, ratingB: number, scoreA: 1 | 0 | 0.5, k = RATING.kFactor): number {
  const expected = expectedScore(ratingA, ratingB);
  return Math.round(k * (scoreA - expected));
}

export function applyElo(
  ratingA: number,
  ratingB: number,
  scoreA: 1 | 0 | 0.5,
): { ratingA: number; ratingB: number; deltaA: number; deltaB: number } {
  const deltaA = eloDelta(ratingA, ratingB, scoreA);
  const deltaB = eloDelta(ratingB, ratingA, (scoreA === 1 ? 0 : scoreA === 0 ? 1 : 0.5) as 1 | 0 | 0.5);
  return {
    ratingA: Math.max(100, ratingA + deltaA),
    ratingB: Math.max(100, ratingB + deltaB),
    deltaA,
    deltaB,
  };
}

export interface AchievementDefinition {
  code: string;
  name: string;
  description: string;
  icon: string;
}

export const ACHIEVEMENTS: AchievementDefinition[] = [
  { code: "first_duel", name: "First Blood", description: "Complete your first duel", icon: "◆" },
  { code: "first_win", name: "Opening Move", description: "Win a duel", icon: "✦" },
  { code: "streak_3", name: "Momentum", description: "Win 3 duels in a row", icon: "⟁" },
  { code: "streak_5", name: "Unbroken", description: "Win 5 duels in a row", icon: "⬢" },
  { code: "combo_2x", name: "Overclocked", description: "Reach a 2× combo multiplier", icon: "⚡" },
  { code: "score_1000", name: "Four Digits", description: "Score 1,000 points in a duel", icon: "λ" },
  { code: "beat_computer", name: "Machine Breaker", description: "Defeat the Chain Duel computer", icon: "⌘" },
  { code: "ten_matches", name: "Veteran", description: "Play 10 duels", icon: "✚" },
  { code: "fifty_matches", name: "Decurion", description: "Play 50 duels", icon: "✵" },
  { code: "duelist", name: "Duelist", description: "Reach a duel rating of 1,200", icon: "◈" },
];

export function evaluateAchievements(input: {
  gamesPlayed: number;
  wins: number;
  streak: number;
  rating: number;
  maxCombo: number;
  bestMultiplier: number;
  score: number;
  opponentLabel: string;
  won: boolean;
}): string[] {
  const unlocked: string[] = [];
  if (input.gamesPlayed >= 1) unlocked.push("first_duel");
  if (input.wins >= 1) unlocked.push("first_win");
  if (input.streak >= 3) unlocked.push("streak_3");
  if (input.streak >= 5) unlocked.push("streak_5");
  if (input.bestMultiplier >= 2) unlocked.push("combo_2x");
  if (input.score >= 1_000) unlocked.push("score_1000");
  if (input.won && /computer|vex/i.test(input.opponentLabel)) unlocked.push("beat_computer");
  if (input.gamesPlayed >= 10) unlocked.push("ten_matches");
  if (input.gamesPlayed >= 50) unlocked.push("fifty_matches");
  if (input.rating >= 1_200) unlocked.push("duelist");
  return unlocked;
}
