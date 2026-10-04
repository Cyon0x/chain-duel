# Audio & soundtrack

Chain Duel's audio is **fully synthesised in the browser with the Web Audio API**. There
are no audio files in the repository, nothing to download, and nothing to preload.

## Licensing

The soundtrack is an **original work authored for Chain Duel**. It is defined as data in
[`src/lib/sound/music.ts`](../src/lib/sound/music.ts) — an 8-bar, 124 BPM electro/arcade
loop — and rendered at runtime by
[`src/lib/sound/audio.ts`](../src/lib/sound/audio.ts).

Because the composition is generated from Chain Duel's own source rather than sampled,
there are no third-party recordings, no samples, and no attribution obligations. It
carries no copyright risk from commercial or recognisable music. Sound effects are
likewise synthesised from oscillator recipes in the same file.

## How it plays

- **One instance, ever.** `export const sound = new SoundEngine()` is a module singleton.
  Client-side navigation reuses the same `AudioContext` and the same music bed, so
  components re-rendering or remounting can never stack soundtracks. `startMusic()` is
  idempotent.
- **Gapless loop.** A look-ahead scheduler queues 16th notes ~200 ms ahead of the audio
  clock, so the loop point is sample-accurate and never clicks or restarts. Each note is a
  short, self-stopping node — nothing accumulates, so CPU stays flat (a few nodes per 16th
  note, no convolver, no decoding).
- **Low level.** The music bed sits at 0.15 of a 0.75 master and ducks to 0.1 while a duel
  is live so hit feedback cuts through.
- **Cheap when idle.** The sequencer is paused when the tab is hidden and resumes from its
  current position.

## Autoplay policy

Browsers block audio until the user interacts. Chain Duel handles this without console noise:

1. On load the engine **tries to start immediately** if the document already has user
   activation (`navigator.userActivation.hasBeenActive`) — e.g. an in-app navigation or a
   returning session.
2. Otherwise it installs one-shot `pointerdown`/`keydown`/`touchstart` listeners and starts
   on the **first meaningful interaction**. The `AudioContext` is never created on a cold
   load, which would be blocked and only log a warning.
3. Entering a duel calls `sound.ensurePlaying()`, so the soundtrack is running by the time
   play begins wherever the browser permits.

## Preferences

| Key | Values | Meaning |
| --- | --- | --- |
| `cd.sound` | `on` / `off` | Master switch. Mutes the soundtrack and all cues, and keeps the audio graph warm so unmuting is instant and positional. |
| `cd.music` | `on` / `off` | Just the soundtrack. Defaults to **on**; only an explicit opt-out is stored. |

The header's speaker control drives the master switch; the settings page exposes the
soundtrack separately.

## Verification

`src/lib/sound/music.test.ts` covers the composition (loop length, determinism, layer
coverage, audible pitch ranges, per-bar chord voicing).

Playback, autoplay, mute and persistence are additionally verified in real Chrome via a
throwaway harness that measures output on the master bus with an `AnalyserNode`:

- autoplay permitted: the soundtrack starts on a cold load with no interaction, creates a
  single `AudioContext`, and keeps its position across in-app navigation;
- autoplay blocked: the context is created but stays silent, then the first
  click/tap/keypress starts playback — with no console output from the blocked attempt;
- the toggle mutes the graph without tearing it down, unpausing continues from the paused
  position, and the choice survives navigation and reload;
- a live duel docks the bed to 0.65 of its level and restores it on exit;
- the control is a 40px tap target on mobile and renders no text.
