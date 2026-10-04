"use client";

import clsx from "clsx";
import { usePreferences } from "./providers";

/**
 * Chain Duel's single sound control: one speaker glyph that carries both
 * states. Sound on shows a live speaker with animated waves and an accent
 * glow; sound off swaps the waves for a mute cross and drops to a dim tone.
 * No text button, no media player — just the game's own audio affordance.
 */
export function SoundToggle({ className }: { className?: string }) {
  const { soundEnabled, toggleSound } = usePreferences();

  return (
    <button
      type="button"
      onClick={toggleSound}
      aria-pressed={soundEnabled}
      aria-label={soundEnabled ? "Sound on — mute music and sound effects" : "Sound off — unmute music and sound effects"}
      title={soundEnabled ? "Sound on" : "Sound off"}
      className={clsx(
        "sound-toggle focus-ring grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-transparent",
        "text-muted transition-colors hover:bg-surface hover:text-ink",
        soundEnabled ? "sound-toggle--on text-accent" : "sound-toggle--off text-dim",
        className,
      )}
    >
      <span className="sound-toggle__glow" aria-hidden />
      <svg className="sound-toggle__icon" viewBox="0 0 24 24" aria-hidden focusable="false">
        <path
          className="sound-toggle__body"
          d="M4.6 9.3h2.9L11 6.4c.6-.5 1.6-.1 1.6.7v9.8c0 .8-1 1.2-1.6.7L7.5 14.7H4.6c-.5 0-.9-.4-.9-.9v-3.6c0-.5.4-.9.9-.9z"
        />
        <path className="sound-toggle__wave sound-toggle__wave--1" d="M15 9.4a4.3 4.3 0 0 1 0 5.2" />
        <path className="sound-toggle__wave sound-toggle__wave--2" d="M17.7 6.9a7.9 7.9 0 0 1 0 10.2" />
        <path className="sound-toggle__mute" d="M15.6 9.8l4.6 4.6M20.2 9.8l-4.6 4.6" />
      </svg>
    </button>
  );
}
