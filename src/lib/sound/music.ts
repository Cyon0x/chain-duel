/**
 * Chain Duel — original soundtrack.
 *
 * This module is the composition itself: a deterministic, 8-bar, 124 BPM
 * arcade/electro loop written as data. `src/lib/sound/audio.ts` renders it with
 * the Web Audio API, so there is no binary asset to ship, nothing to preload
 * and no licensing question — the music is an original work authored for Chain
 * Duel (see docs/audio.md).
 *
 * The loop is deliberately built from short, scheduled events rather than one
 * long buffer: the sequencer tiles bars exactly, so the loop point is
 * sample-accurate and never clicks or restarts audibly.
 */

export const MUSIC = {
  bpm: 124,
  stepsPerBar: 16,
  bars: 8,
} as const;

/** Total 16th-note steps in one full loop (128). */
export const MUSIC_LOOP_STEPS = MUSIC.bars * MUSIC.stepsPerBar;
/** Duration of one 16th note in seconds. */
export const MUSIC_STEP_SECONDS = 60 / MUSIC.bpm / 4;

export type MusicLayer = "kick" | "snare" | "hat" | "bass" | "pluck" | "pad" | "riser";

export interface MusicEvent {
  layer: MusicLayer;
  /** Level relative to the music bus. */
  gain: number;
  /** Pitch in Hz for the monophonic pitched layers. */
  frequency?: number;
  /** Triad for the pad layer. */
  chord?: number[];
  /** Envelope length in seconds. */
  duration?: number;
  accent?: boolean;
}

/** Am – F – C – G, two passes: the harmonic backbone of the loop. */
export const MUSIC_CHORDS: readonly (readonly number[])[] = [
  [220.0, 261.63, 329.63], // Am
  [174.61, 220.0, 261.63], // F
  [261.63, 329.63, 392.0], // C
  [196.0, 246.94, 293.66], // G
];

/** Bass roots matching MUSIC_CHORDS, in the low-mid register. */
const BASS_ROOTS: readonly number[] = [110.0, 87.31, 130.81, 98.0];

/** A minor pentatonic lead register — bright, competitive, never muddy. */
export const MUSIC_LEAD: readonly number[] = [440.0, 523.25, 587.33, 659.25, 783.99];

const KICK_STEPS = new Set([0, 4, 8, 12]);
const SNARE_STEPS = new Set([4, 12]);
const HAT_STEPS = new Set([0, 2, 4, 6, 8, 10, 12, 14]);

/** step -> octave multiplier for the driving bass line. */
const BASS_STEPS = new Map<number, number>([
  [0, 1],
  [1, 1],
  [2, 1],
  [4, 1],
  [6, 2],
  [8, 1],
  [9, 1],
  [10, 1],
  [12, 1],
  [14, 2],
]);

/** [step, degree into MUSIC_LEAD] — a hook that varies across the 8 bars. */
const LEAD_HOOK: readonly (readonly (readonly [number, number])[])[] = [
  [[0, 0], [3, 2], [6, 1], [10, 0], [14, 3]],
  [[0, 4], [2, 3], [6, 2], [8, 1], [12, 2], [15, 0]],
  [[0, 2], [4, 3], [7, 4], [10, 3], [13, 1]],
  [[0, 3], [4, 2], [8, 1], [10, 0], [12, 2], [14, 4]],
  [[0, 0], [3, 2], [6, 1], [10, 0], [14, 3]],
  [[2, 4], [4, 3], [8, 2], [10, 1], [12, 2]],
  [[0, 2], [4, 3], [7, 4], [10, 3], [13, 1], [15, 0]],
  [[0, 3], [4, 2], [8, 1], [10, 0], [12, 4], [14, 3]],
];

function wrapStep(stepInLoop: number): number {
  return ((stepInLoop % MUSIC_LOOP_STEPS) + MUSIC_LOOP_STEPS) % MUSIC_LOOP_STEPS;
}

export function barForStep(stepInLoop: number): number {
  return Math.floor(wrapStep(stepInLoop) / MUSIC.stepsPerBar);
}

export function chordForBar(bar: number): readonly number[] {
  return MUSIC_CHORDS[((bar % MUSIC_CHORDS.length) + MUSIC_CHORDS.length) % MUSIC_CHORDS.length];
}

/**
 * Every voice that should sound on a given 16th-note step of the loop. Pure and
 * deterministic so the arrangement can be unit-tested without an audio device.
 */
export function eventsForStep(stepInLoop: number): MusicEvent[] {
  const loopStep = wrapStep(stepInLoop);
  const bar = Math.floor(loopStep / MUSIC.stepsPerBar);
  const step = loopStep % MUSIC.stepsPerBar;
  const events: MusicEvent[] = [];

  const kick = KICK_STEPS.has(step) || (bar % 2 === 1 && step === 14) || ((bar === 3 || bar === 7) && step === 10);
  if (kick) events.push({ layer: "kick", gain: step === 0 || step === 8 ? 0.62 : 0.5, accent: step === 0 });

  if (SNARE_STEPS.has(step)) events.push({ layer: "snare", gain: 0.26, duration: 0.17 });

  if (HAT_STEPS.has(step)) {
    const accent = step % 4 === 2;
    events.push({ layer: "hat", gain: accent ? 0.11 : 0.055, duration: accent ? 0.07 : 0.04 });
  }
  if (bar % 2 === 1 && step === 15) events.push({ layer: "hat", gain: 0.045, duration: 0.03 });

  const octave = BASS_STEPS.get(step);
  if (octave) {
    events.push({
      layer: "bass",
      frequency: BASS_ROOTS[bar % BASS_ROOTS.length] * octave,
      gain: 0.3,
      duration: 0.19,
    });
  }

  for (const [leadStep, degree] of LEAD_HOOK[bar]) {
    if (leadStep === step) {
      events.push({ layer: "pluck", frequency: MUSIC_LEAD[degree % MUSIC_LEAD.length], gain: 0.2, duration: 0.32 });
    }
  }

  if (step === 0) {
    events.push({ layer: "pad", chord: [...chordForBar(bar)], gain: 0.05, duration: MUSIC_STEP_SECONDS * MUSIC.stepsPerBar * 0.94 });
  }

  if (bar === MUSIC.bars - 1 && step === 12) {
    events.push({ layer: "riser", gain: 0.1, duration: MUSIC_STEP_SECONDS * 4 });
  }

  return events;
}
