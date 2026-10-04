"use client";

/**
 * Chain Duel audio.
 *
 * Everything is synthesised with the Web Audio API: there are no binary assets
 * to ship, nothing to download and no licensing to track. The soundtrack is the
 * original composition in `./music`, rendered by a look-ahead step sequencer so
 * the loop is gapless and the CPU cost stays flat (a few short nodes per 16th
 * note, nothing running when the tab is hidden).
 *
 * Autoplay policy: browsers only allow audio to start after a gesture. We try
 * the polite path first — if the document already has user activation the
 * soundtrack starts immediately, otherwise a one-shot listener starts it on the
 * first pointer/key interaction. The AudioContext is never created on a cold
 * load, which would be blocked and only add console noise.
 */

import { MUSIC_LOOP_STEPS, MUSIC_STEP_SECONDS, eventsForStep } from "./music";

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

/** Music bed level. Kept low on purpose: it frames gameplay, never covers it. */
const MUSIC_GAIN = 0.15;
/** Slightly quieter while a duel is live so hit feedback cuts through. */
const MUSIC_GAIN_DUCKED = 0.1;
const FADE_IN_SECONDS = 1.4;
const FADE_OUT_SECONDS = 0.3;
/** How far ahead of the clock we queue notes, and how often we top the queue up. */
const LOOKAHEAD_SECONDS = 0.2;
const SCHEDULER_INTERVAL_MS = 40;
/** Dotted-8th echo on the lead pluck — cheap way to sound produced. */
const DELAY_SECONDS = MUSIC_STEP_SECONDS * 3;
/** Wet mix for the lead echo. */
const DELAY_SEND_GAIN = 0.3;

export interface AudioSnapshot {
  contexts: number;
  /** Voices currently scheduled/ringing — proves the sequencer is producing notes. */
  activeVoices: number;
  /** Current music bus level (0 when muted, lower while a duel is live). */
  musicLevel: number;
  state: AudioContextState | "none";
  musicRunning: boolean;
  stepIndex: number;
  enabled: boolean;
  musicEnabled: boolean;
  matchActive: boolean;
  gestureSeen: boolean;
}

class SoundEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBed: GainNode | null = null;
  private musicDuck: GainNode | null = null;
  private delaySend: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private active: AudioScheduledSourceNode[] = [];
  private lastPlayed = new Map<SoundCue, number>();

  private timer: number | null = null;
  private nextStepTime = 0;
  private stepIndex = 0;
  private musicRunning = false;
  private matchActive = false;
  private gestureSeen = false;
  private gestureHookInstalled = false;
  private visibilityHookInstalled = false;

  enabled = true;
  musicEnabled = true;

  /* --------------------------------------------------------------- plumbing */

  private ensureContext(): AudioContext | null {
    if (typeof window === "undefined") return null;
    if (this.context) return this.context;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;

    const context = new Ctor();
    const master = context.createGain();
    master.gain.value = 0.75;
    master.connect(context.destination);

    const sfxBus = context.createGain();
    sfxBus.gain.value = 1;
    sfxBus.connect(master);

    // musicDuck stays at 1; the bed carries the level. Two nodes so ducking and
    // start/stop fades never fight over the same AudioParam.
    const musicDuck = context.createGain();
    musicDuck.gain.value = 1;
    musicDuck.connect(master);

    const musicBed = context.createGain();
    musicBed.gain.value = 0;
    musicBed.connect(musicDuck);

    // Dotted-8th echo: short, filtered, low-feedback — gives the lead space
    // without a convolver's CPU cost.
    const delaySend = context.createGain();
    delaySend.gain.value = DELAY_SEND_GAIN;
    const delay = context.createDelay(1);
    delay.delayTime.value = DELAY_SECONDS;
    const feedback = context.createGain();
    feedback.gain.value = 0.26;
    const damp = context.createBiquadFilter();
    damp.type = "lowpass";
    damp.frequency.value = 2600;
    delaySend.connect(delay);
    delay.connect(damp);
    damp.connect(feedback);
    feedback.connect(delay);
    damp.connect(musicBed);

    const noiseBuffer = context.createBuffer(1, Math.floor(context.sampleRate * 1.5), context.sampleRate);
    const channel = noiseBuffer.getChannelData(0);
    for (let index = 0; index < channel.length; index += 1) channel[index] = Math.random() * 2 - 1;

    this.context = context;
    this.master = master;
    this.sfxBus = sfxBus;
    this.musicDuck = musicDuck;
    this.musicBed = musicBed;
    this.delaySend = delaySend;
    this.noiseBuffer = noiseBuffer;
    this.installVisibilityHook();
    return context;
  }

  private track(node: AudioScheduledSourceNode): void {
    this.active.push(node);
    node.addEventListener("ended", () => {
      const index = this.active.indexOf(node);
      if (index >= 0) this.active.splice(index, 1);
    });
  }

  /** Create/resume the audio graph. Must be called from a user gesture. */
  unlock(): void {
    this.gestureSeen = true;
    const context = this.ensureContext();
    if (context && context.state === "suspended") void context.resume();
  }

  /**
   * One-shot listeners: the context is only built from inside a real gesture,
   * so a blocked autoplay never logs a console error.
   */
  private primeOnGesture(): void {
    if (this.gestureHookInstalled || typeof window === "undefined") return;
    this.gestureHookInstalled = true;
    const unlock = () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("touchstart", unlock);
      this.unlock();
      if (this.enabled && this.musicEnabled) this.startMusic();
    };
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("keydown", unlock);
    window.addEventListener("touchstart", unlock, { passive: true });
  }

  /**
   * Start the soundtrack if we are allowed to. If the document already carries
   * user activation (a returning in-app navigation, or a gesture earlier in the
   * session) it starts now; otherwise we wait for the first interaction.
   */
  private requestMusic(): void {
    if (!this.enabled || !this.musicEnabled || typeof window === "undefined") return;
    if (this.gestureSeen) {
      this.unlock();
      this.startMusic();
      return;
    }
    const activation = (navigator as Navigator & { userActivation?: { hasBeenActive?: boolean } })
      .userActivation;
    if (activation?.hasBeenActive) {
      this.unlock();
      this.startMusic();
      return;
    }
    // Otherwise make a real attempt: a context that comes up "running" means
    // this browser/profile permits playback without a gesture. If it stays
    // "suspended" we never call resume() here — that would only log a block
    // warning — and instead wait for the first interaction.
    const context = this.ensureContext();
    if (context && context.state === "running") {
      this.gestureSeen = true;
      this.startMusic();
      return;
    }
    this.primeOnGesture();
  }

  /** Public alias used by gameplay screens that want music running on entry. */
  ensurePlaying(): void {
    this.requestMusic();
  }

  private installVisibilityHook(): void {
    if (this.visibilityHookInstalled || typeof document === "undefined") return;
    this.visibilityHookInstalled = true;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        // Pause the sequencer (position is preserved) so a background tab costs
        // nothing. The context itself stays warm for an instant resume.
        if (this.musicRunning) this.stopMusic();
      } else {
        this.requestMusic();
      }
    });
  }

  /* ------------------------------------------------------------- public api */

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) {
      this.requestMusic();
    } else {
      this.stopMusic();
    }
  }

  setMusicEnabled(enabled: boolean): void {
    this.musicEnabled = enabled;
    if (enabled) this.requestMusic();
    else this.stopMusic();
  }

  /** Duck the bed while a duel is live; gameplay feedback stays on top. */
  setMatchActive(active: boolean): void {
    this.matchActive = active;
    const context = this.context;
    if (!context || !this.musicDuck) return;
    const now = context.currentTime;
    this.musicDuck.gain.cancelScheduledValues(now);
    this.musicDuck.gain.setValueAtTime(this.musicDuck.gain.value, now);
    this.musicDuck.gain.linearRampToValueAtTime(active ? 0.65 : 1, now + 0.35);
  }

  play(cue: SoundCue): void {
    if (!this.enabled) return;
    // Never build an AudioContext before the first interaction: autoplay policy
    // blocks it and it only creates console noise.
    if (!this.context && !this.gestureSeen) return;
    const context = this.ensureContext();
    if (!context || !this.sfxBus) return;
    if (context.state === "suspended") {
      void context.resume();
      return;
    }

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
      gain.connect(this.sfxBus);
      oscillator.start(start);
      oscillator.stop(start + tone.duration + 0.02);
      this.track(oscillator);
    }
  }

  snapshot(): AudioSnapshot {
    return {
      contexts: this.context ? 1 : 0,
      activeVoices: this.active.length,
      musicLevel: this.musicDuck ? this.musicDuck.gain.value : 0,
      state: this.context?.state ?? "none",
      musicRunning: this.musicRunning,
      stepIndex: this.stepIndex,
      enabled: this.enabled,
      musicEnabled: this.musicEnabled,
      matchActive: this.matchActive,
      gestureSeen: this.gestureSeen,
    };
  }

  /* ----------------------------------------------------------------- music */

  private startMusic(): void {
    const context = this.ensureContext();
    if (!context || !this.musicBed) return;
    if (this.musicRunning) return;

    this.musicRunning = true;
    this.nextStepTime = context.currentTime + 0.05;
    const target = this.matchActive ? MUSIC_GAIN_DUCKED : MUSIC_GAIN;
    this.musicBed.gain.cancelScheduledValues(context.currentTime);
    this.musicBed.gain.setValueAtTime(Math.max(this.musicBed.gain.value, 0.0001), context.currentTime);
    this.musicBed.gain.linearRampToValueAtTime(target, context.currentTime + FADE_IN_SECONDS);

    this.timer = window.setInterval(this.tick, SCHEDULER_INTERVAL_MS);
    this.tick();
  }

  private stopMusic(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.musicRunning = false;

    const context = this.context;
    if (context && this.musicBed) {
      const now = context.currentTime;
      this.musicBed.gain.cancelScheduledValues(now);
      this.musicBed.gain.setValueAtTime(Math.max(this.musicBed.gain.value, 0.0001), now);
      this.musicBed.gain.linearRampToValueAtTime(0.0001, now + FADE_OUT_SECONDS);
    }

    const nodes = this.active;
    this.active = [];
    if (context && nodes.length > 0) {
      window.setTimeout(() => {
        for (const node of nodes) {
          try {
            node.stop();
          } catch {
            // already stopped
          }
        }
      }, FADE_OUT_SECONDS * 1000 + 80);
    }
  }

  /** Look-ahead scheduler: queue every step that falls inside the window. */
  private tick = (): void => {
    const context = this.context;
    if (!context || !this.musicRunning) return;
    const now = context.currentTime;
    if (this.nextStepTime < now) this.nextStepTime = now + 0.02;
    while (this.nextStepTime < now + LOOKAHEAD_SECONDS) {
      this.scheduleStep(this.stepIndex, this.nextStepTime);
      this.stepIndex = (this.stepIndex + 1) % MUSIC_LOOP_STEPS;
      this.nextStepTime += MUSIC_STEP_SECONDS;
    }
  };

  private scheduleStep(stepIndex: number, time: number): void {
    for (const event of eventsForStep(stepIndex)) {
      switch (event.layer) {
        case "kick":
          this.kick(time, event.gain);
          break;
        case "snare":
          this.snare(time, event.gain, event.duration ?? 0.17);
          break;
        case "hat":
          this.hat(time, event.gain, event.duration ?? 0.04);
          break;
        case "bass":
          if (event.frequency) this.bass(time, event.frequency, event.gain, event.duration ?? 0.19);
          break;
        case "pluck":
          if (event.frequency) this.pluck(time, event.frequency, event.gain, event.duration ?? 0.32);
          break;
        case "pad":
          if (event.chord) this.pad(time, event.chord, event.gain, event.duration ?? 1.8);
          break;
        case "riser":
          this.riser(time, event.gain, event.duration ?? 0.5);
          break;
      }
    }
  }

  private noiseSource(): AudioBufferSourceNode | null {
    const context = this.context;
    if (!context || !this.noiseBuffer) return null;
    const source = context.createBufferSource();
    source.buffer = this.noiseBuffer;
    return source;
  }

  private envGain(time: number, peak: number, attack: number, duration: number): GainNode | null {
    const context = this.context;
    if (!context) return null;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0001), time + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    return gain;
  }

  private kick(time: number, level: number): void {
    const context = this.context;
    if (!context || !this.musicBed || !this.sfxBus) return;
    const oscillator = context.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(155, time);
    oscillator.frequency.exponentialRampToValueAtTime(46, time + 0.1);
    const gain = this.envGain(time, level, 0.004, 0.3);
    if (!gain) return;
    oscillator.connect(gain);
    gain.connect(this.musicBed);
    oscillator.start(time);
    oscillator.stop(time + 0.32);
    this.track(oscillator);

    // Short click transient so the kick reads on phone speakers too.
    const click = this.noiseSource();
    if (click) {
      const clickGain = this.envGain(time, level * 0.28, 0.002, 0.03);
      const highpass = context.createBiquadFilter();
      highpass.type = "highpass";
      highpass.frequency.value = 1200;
      click.connect(highpass);
      if (clickGain) {
        highpass.connect(clickGain);
        clickGain.connect(this.musicBed);
      }
      click.start(time);
      click.stop(time + 0.05);
      this.track(click);
    }
  }

  private snare(time: number, level: number, duration: number): void {
    const context = this.context;
    if (!context || !this.musicBed) return;
    const noise = this.noiseSource();
    if (noise) {
      const bandpass = context.createBiquadFilter();
      bandpass.type = "bandpass";
      bandpass.frequency.value = 1900;
      bandpass.Q.value = 0.8;
      const gain = this.envGain(time, level, 0.003, duration);
      noise.connect(bandpass);
      if (gain) {
        bandpass.connect(gain);
        gain.connect(this.musicBed);
      }
      noise.start(time);
      noise.stop(time + duration + 0.03);
      this.track(noise);
    }
    const body = context.createOscillator();
    body.type = "triangle";
    body.frequency.setValueAtTime(210, time);
    body.frequency.exponentialRampToValueAtTime(150, time + 0.09);
    const bodyGain = this.envGain(time, level * 0.4, 0.003, 0.1);
    if (bodyGain) {
      body.connect(bodyGain);
      bodyGain.connect(this.musicBed);
      body.start(time);
      body.stop(time + 0.12);
      this.track(body);
    }
  }

  private hat(time: number, level: number, duration: number): void {
    const context = this.context;
    if (!context || !this.musicBed) return;
    const noise = this.noiseSource();
    if (!noise) return;
    const highpass = context.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = 7800;
    const gain = this.envGain(time, level, 0.002, duration);
    noise.connect(highpass);
    if (gain) {
      highpass.connect(gain);
      gain.connect(this.musicBed);
    }
    noise.start(time);
    noise.stop(time + duration + 0.03);
    this.track(noise);
  }

  private bass(time: number, frequency: number, level: number, duration: number): void {
    const context = this.context;
    if (!context || !this.musicBed) return;
    const oscillator = context.createOscillator();
    oscillator.type = "sawtooth";
    oscillator.frequency.setValueAtTime(frequency, time);
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 7;
    filter.frequency.setValueAtTime(340, time);
    filter.frequency.exponentialRampToValueAtTime(1500, time + 0.02);
    filter.frequency.exponentialRampToValueAtTime(280, time + duration);
    const gain = this.envGain(time, level, 0.006, duration);
    oscillator.connect(filter);
    if (gain) {
      filter.connect(gain);
      gain.connect(this.musicBed);
      oscillator.start(time);
      oscillator.stop(time + duration + 0.03);
      this.track(oscillator);
    }

    const sub = context.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(frequency / 2, time);
    const subGain = this.envGain(time, level * 0.55, 0.008, duration * 1.1);
    if (subGain) {
      sub.connect(subGain);
      subGain.connect(this.musicBed);
      sub.start(time);
      sub.stop(time + duration + 0.05);
      this.track(sub);
    }
  }

  private pluck(time: number, frequency: number, level: number, duration: number): void {
    const context = this.context;
    if (!context || !this.musicBed) return;
    const oscillator = context.createOscillator();
    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(frequency, time);
    const shimmer = context.createOscillator();
    shimmer.type = "square";
    shimmer.frequency.setValueAtTime(frequency * 2, time);
    shimmer.detune.value = 6;
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(4200, time);
    filter.frequency.exponentialRampToValueAtTime(900, time + duration);
    const gain = this.envGain(time, level, 0.004, duration);
    const shimmerGain = this.envGain(time, level * 0.22, 0.004, duration * 0.7);
    oscillator.connect(filter);
    if (shimmerGain) {
      shimmer.connect(shimmerGain);
      shimmerGain.connect(filter);
    }
    if (gain) {
      filter.connect(gain);
      gain.connect(this.musicBed);
      if (this.delaySend) gain.connect(this.delaySend);
      oscillator.start(time);
      oscillator.stop(time + duration + 0.03);
      shimmer.start(time);
      shimmer.stop(time + duration + 0.03);
      this.track(oscillator);
      this.track(shimmer);
    }
  }

  private pad(time: number, chord: number[], level: number, duration: number): void {
    const context = this.context;
    if (!context || !this.musicBed) return;
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1100;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(level, time + 0.4);
    gain.gain.setValueAtTime(level, time + duration * 0.7);
    gain.gain.linearRampToValueAtTime(0.0001, time + duration);
    filter.connect(gain);
    gain.connect(this.musicBed);
    for (const frequency of chord) {
      for (const detune of [-5, 5]) {
        const oscillator = context.createOscillator();
        oscillator.type = "sawtooth";
        oscillator.frequency.setValueAtTime(frequency, time);
        oscillator.detune.value = detune;
        oscillator.connect(filter);
        oscillator.start(time);
        oscillator.stop(time + duration + 0.1);
        this.track(oscillator);
      }
    }
    if (this.delaySend) gain.connect(this.delaySend);
  }

  private riser(time: number, level: number, duration: number): void {
    const context = this.context;
    if (!context || !this.musicBed) return;
    const noise = this.noiseSource();
    if (!noise) return;
    const bandpass = context.createBiquadFilter();
    bandpass.type = "bandpass";
    bandpass.Q.value = 1.2;
    bandpass.frequency.setValueAtTime(420, time);
    bandpass.frequency.exponentialRampToValueAtTime(6400, time + duration);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(level, time + duration * 0.85);
    gain.gain.linearRampToValueAtTime(0.0001, time + duration);
    noise.connect(bandpass);
    bandpass.connect(gain);
    gain.connect(this.musicBed);
    noise.start(time);
    noise.stop(time + duration + 0.05);
    this.track(noise);
  }
}

export const sound = new SoundEngine();

// Development-only handle used by the audio test harness: it can read engine
// state and drive the same public methods the game screens call, so playback
// policy (mute, ducking, single instance) is verifiable in a real browser.
// Never shipped to production.
interface AudioTestHandle {
  snapshot: () => AudioSnapshot;
  setMatchActive: (active: boolean) => void;
}

if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
  (window as unknown as { __chainDuelAudio?: AudioTestHandle }).__chainDuelAudio = {
    snapshot: () => sound.snapshot(),
    setMatchActive: (active: boolean) => sound.setMatchActive(active),
  };
}
