import { describe, expect, it } from "vitest";
import { DUEL_CLICK_CUES, isCueAudible, type SoundCue } from "./audio";

const ALL_CUES: SoundCue[] = [
  "start",
  "countdown",
  "countdownGo",
  "hit",
  "gold",
  "wrong",
  "miss",
  "combo",
  "victory",
  "defeat",
  "transaction",
  "ui",
];

describe("sound mute policy", () => {
  it("plays everything while sound is on", () => {
    for (const cue of ALL_CUES) {
      expect(isCueAudible(cue, { enabled: true, matchActive: false })).toBe(true);
      expect(isCueAudible(cue, { enabled: true, matchActive: true })).toBe(true);
    }
  });

  it("silences everything while muted outside a duel", () => {
    for (const cue of ALL_CUES) {
      expect(isCueAudible(cue, { enabled: false, matchActive: false })).toBe(false);
    }
  });

  it("keeps the ball click audible while muted during a duel", () => {
    for (const cue of DUEL_CLICK_CUES) {
      expect(isCueAudible(cue, { enabled: false, matchActive: true })).toBe(true);
    }
    expect(DUEL_CLICK_CUES.has("hit")).toBe(true);
    expect(DUEL_CLICK_CUES.has("gold")).toBe(true);
  });

  it("still silences ambience, results and UI while muted in a duel", () => {
    for (const cue of ALL_CUES.filter((entry) => !DUEL_CLICK_CUES.has(entry))) {
      expect(isCueAudible(cue, { enabled: false, matchActive: true })).toBe(false);
    }
  });
});
