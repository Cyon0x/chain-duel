"use client";

/**
 * Chain Duel audio is synthesised with the Web Audio API, so there are no
 * binary assets to ship and no autoplay surprises: the context is only created
 * after an explicit user gesture (the global sound toggle).
 */

export type SoundCue =
  | "start"
  | "countdown"
  | "countdownGo"
  | "hit"
  | "gold"
  | "wrong"
  | "miss"
  | "combo"
  | "victory"
  | "defeat"
  | "transaction"
  | "ui";

interface ToneSpec {
  type: OscillatorType;
  from: number;
  to: number;
  duration: number;
  gain: number;
  delay?: number;
}

const CUES: Record<SoundCue, ToneSpec[]> = {
  start: [
    { type: "sine", from: 180, to: 420, duration: 0.32, gain: 0.22 },
    { type: "triangle", from: 420, to: 880, duration: 0.34, gain: 0.14, delay: 0.1 },
  ],
  countdown: [{ type: "sine", from: 640, to: 640, duration: 0.14, gain: 0.16 }],
  countdownGo: [
    { type: "triangle", from: 520, to: 1180, duration: 0.42, gain: 0.24 },
    { type: "sine", from: 240, to: 620, duration: 0.5, gain: 0.16, delay: 0.04 },
  ],
  hit: [{ type: "triangle", from: 900, to: 1500, duration: 0.09, gain: 0.14 }],
  gold: [
    { type: "triangle", from: 1100, to: 1900, duration: 0.12, gain: 0.18 },
    { type: "sine", from: 1500, to: 2400, duration: 0.16, gain: 0.12, delay: 0.05 },
  ],
  wrong: [{ type: "sawtooth", from: 240, to: 90, duration: 0.22, gain: 0.16 }],
  miss: [{ type: "sine", from: 200, to: 120, duration: 0.1, gain: 0.08 }],
  combo: [
    { type: "sine", from: 1300, to: 2100, duration: 0.13, gain: 0.14 },
    { type: "sine", from: 1700, to: 2600, duration: 0.15, gain: 0.1, delay: 0.06 },
  ],
  victory: [
    { type: "triangle", from: 520, to: 780, duration: 0.3, gain: 0.2 },
    { type: "triangle", from: 780, to: 1180, duration: 0.42, gain: 0.18, delay: 0.16 },
    { type: "sine", from: 1180, to: 1580, duration: 0.5, gain: 0.16, delay: 0.34 },
  ],
  defeat: [
    { type: "sine", from: 380, to: 220, duration: 0.5, gain: 0.18 },
    { type: "triangle", from: 220, to: 130, duration: 0.6, gain: 0.14, delay: 0.24 },
  ],
  transaction: [
    { type: "sine", from: 880, to: 1320, duration: 0.16, gain: 0.14 },
    { type: "sine", from: 1320, to: 1760, duration: 0.2, gain: 0.12, delay: 0.1 },
  ],
  ui: [{ type: "sine", from: 700, to: 900, duration: 0.06, gain: 0.07 }],
};

class SoundEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private musicNodes: OscillatorNode[] = [];
  private lastPlayed = new Map<SoundCue, number>();

  enabled = true;
  musicEnabled = false;

  private ensureContext(): AudioContext | null {
    if (typeof window === "undefined") return null;
    if (this.context) return this.context;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    this.context = new Ctor();
    this.master = this.context.createGain();
    this.master.gain.value = 0.75;
    this.master.connect(this.context.destination);
    this.musicGain = this.context.createGain();
    this.musicGain.gain.value = 0;
    this.musicGain.connect(this.master);
    return this.context;
  }

  unlock(): void {
    const context = this.ensureContext();
    if (context && context.state === "suspended") void context.resume();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) {
      this.unlock();
      if (this.musicEnabled) this.startMusic();
    } else {
      this.stopMusic();
    }
  }

  /**
   * A soft synthesised ambient pad. Generated with the Web Audio API so there
   * are no audio assets to ship, and it only ever starts after a user gesture.
   */
  setMusicEnabled(enabled: boolean): void {
    this.musicEnabled = enabled;
    if (enabled) {
      this.unlock();
      this.startMusic();
    } else {
      this.stopMusic();
    }
  }

  private startMusic(): void {
    const context = this.ensureContext();
    if (!context || !this.musicGain) return;
    if (context.state === "suspended" || this.musicNodes.length > 0) return;
    const now = context.currentTime;
    const voices = [
      { frequency: 110, detune: -6 },
      { frequency: 164.81, detune: 4 },
      { frequency: 220, detune: 7 },
    ];
    for (const voice of voices) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = voice.frequency;
      oscillator.detune.value = voice.detune;
      gain.gain.value = 0.14;
      oscillator.connect(gain);
      gain.connect(this.musicGain);
      oscillator.start(now);
      this.musicNodes.push(oscillator);
    }
    this.musicGain.gain.cancelScheduledValues(now);
    this.musicGain.gain.setValueAtTime(this.musicGain.gain.value, now);
    this.musicGain.gain.linearRampToValueAtTime(0.05, now + 3);
  }

  private stopMusic(): void {
    const context = this.context;
    if (!context || !this.musicGain) return;
    const now = context.currentTime;
    this.musicGain.gain.cancelScheduledValues(now);
    this.musicGain.gain.setValueAtTime(this.musicGain.gain.value, now);
    this.musicGain.gain.linearRampToValueAtTime(0, now + 0.8);
    const nodes = this.musicNodes;
    this.musicNodes = [];
    window.setTimeout(() => {
      for (const node of nodes) {
        try {
          node.stop();
        } catch {
          // already stopped
        }
      }
    }, 900);
  }

  play(cue: SoundCue): void {
    if (!this.enabled) return;
    const context = this.ensureContext();
    if (!context || !this.master) return;
    if (context.state === "suspended") return;

    const now = context.currentTime;
    const last = this.lastPlayed.get(cue) ?? 0;
    if (now - last < 0.035) return;
    this.lastPlayed.set(cue, now);

    for (const tone of CUES[cue]) {
      const start = now + (tone.delay ?? 0);
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = tone.type;
      oscillator.frequency.setValueAtTime(tone.from, start);
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(tone.to, 1), start + tone.duration);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(tone.gain, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + tone.duration);
      oscillator.connect(gain);
      gain.connect(this.master);
      oscillator.start(start);
      oscillator.stop(start + tone.duration + 0.02);
    }
  }
}

export const sound = new SoundEngine();
