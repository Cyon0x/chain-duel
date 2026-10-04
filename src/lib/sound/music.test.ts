import { describe, expect, it } from "vitest";
import {
  MUSIC,
  MUSIC_CHORDS,
  MUSIC_LEAD,
  MUSIC_LOOP_STEPS,
  MUSIC_STEP_SECONDS,
  barForStep,
  chordForBar,
  eventsForStep,
} from "./music";

const loop = Array.from({ length: MUSIC_LOOP_STEPS }, (_, step) => eventsForStep(step));

describe("soundtrack composition", () => {
  it("is a seamless 8-bar loop at a competitive tempo", () => {
    expect(MUSIC.bpm).toBeGreaterThanOrEqual(120);
    expect(MUSIC_LOOP_STEPS).toBe(128);
    expect(MUSIC_STEP_SECONDS).toBeCloseTo(60 / MUSIC.bpm / 4, 10);
    // One pass of the loop stays under 20s, so it never feels repetitive-dead-air.
    expect(MUSIC_LOOP_STEPS * MUSIC_STEP_SECONDS).toBeLessThan(20);
  });

  it("wraps step lookups so the sequencer can run forever", () => {
    expect(eventsForStep(MUSIC_LOOP_STEPS)).toEqual(eventsForStep(0));
    expect(eventsForStep(-1)).toEqual(eventsForStep(MUSIC_LOOP_STEPS - 1));
    expect(eventsForStep(MUSIC_LOOP_STEPS * 7 + 5)).toEqual(eventsForStep(5));
    expect(barForStep(MUSIC_LOOP_STEPS + 1)).toBe(0);
  });

  it("is deterministic", () => {
    expect(eventsForStep(37)).toEqual(eventsForStep(37));
  });

  it("keeps four-on-the-floor downbeats in every bar", () => {
    for (let bar = 0; bar < MUSIC.bars; bar += 1) {
      for (const step of [0, 4, 8, 12]) {
        const events = eventsForStep(bar * 16 + step);
        expect(events.some((event) => event.layer === "kick")).toBe(true);
      }
    }
  });

  it("drives every layer across the loop", () => {
    const layers = new Set(loop.flat().map((event) => event.layer));
    for (const layer of ["kick", "snare", "hat", "bass", "pluck", "pad", "riser"]) {
      expect(layers.has(layer as never)).toBe(true);
    }
  });

  it("only ever emits safety-audible levels", () => {
    for (const event of loop.flat()) {
      expect(event.gain).toBeGreaterThan(0);
      expect(event.gain).toBeLessThanOrEqual(1);
    }
  });

  it("pitches leads from the A-minor pentatonic hook", () => {
    for (const event of loop.flat().filter((entry) => entry.layer === "pluck")) {
      expect(MUSIC_LEAD).toContain(event.frequency);
    }
  });

  it("roots the bass in an audible register under the chord progression", () => {
    const bass = loop
      .flat()
      .filter((event) => event.layer === "bass")
      .map((event) => event.frequency ?? 0);
    expect(bass.length).toBeGreaterThan(40);
    for (const frequency of bass) {
      expect(frequency).toBeGreaterThanOrEqual(80);
      expect(frequency).toBeLessThanOrEqual(300);
    }
    // Roots repeat across both halves of the progression.
    const roots = new Set(bass.map((frequency) => Math.round(frequency % 110)));
    expect(roots.size).toBeLessThan(bass.length);
  });

  it("voices the pad once per bar on the bar's own chord", () => {
    for (let bar = 0; bar < MUSIC.bars; bar += 1) {
      for (let step = 0; step < 16; step += 1) {
        const pads = eventsForStep(bar * 16 + step).filter((event) => event.layer === "pad");
        if (step === 0) {
          expect(pads).toHaveLength(1);
          expect(pads[0].chord).toEqual([...chordForBar(bar)]);
        } else {
          expect(pads).toHaveLength(0);
        }
      }
    }
    expect(MUSIC_CHORDS).toHaveLength(4);
  });
});
