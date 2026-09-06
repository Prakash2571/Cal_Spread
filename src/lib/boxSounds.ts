/**
 * Box trade audio cues — two short, clearly audible, Web-Audio-generated tones.
 *
 * WHAT CHANGED, AND WHY
 * These started as a deliberately near-silent confirmation: 0.05 gain around 420–560 Hz.
 * In practice that was too easy to miss, which defeats the point — a trade opening or
 * closing is exactly the moment you want to look at the screen. So the cue is now both
 * LOUDER and PITCHED HIGHER, and the two changes compound:
 *
 *   • gain went 0.05 -> 0.18, about +11 dB;
 *   • the tones moved up roughly an octave, into the 659–1175 Hz band where human
 *     hearing is most sensitive. The equal-loudness curves are worth ~8–10 dB on their
 *     own here, so the same gain simply carries further at 1 kHz than at 420 Hz.
 *
 * It is still a trading-terminal cue, not an alarm: pure sine, no harshness, well under
 * half a second, and smooth ramps so there is never a click.
 *
 * Entry RISES and exit FALLS, and that is the load-bearing property — it is how the two
 * are told apart without looking. They also start on different notes, so even the first
 * instant of the cue identifies which one it is. Any change here must preserve both.
 *
 * NON-NEGOTIABLE: playback is completely side-effect-isolated. Every entry point is
 * wrapped so an audio failure — a suspended context, an unsupported browser, autoplay
 * restrictions — can NEVER throw into the Box UI or affect trade processing. On failure
 * it does nothing (and logs only in dev).
 *
 * A single lazily-created AudioContext is reused for the life of the tab; we never
 * construct one per event.
 */

/**
 * Master gain, per tone.
 *
 * Chosen to be unmistakable on laptop speakers while leaving plenty of headroom: the two
 * tones of a cue overlap, so the instantaneous peak can approach 2x this value — 0.36,
 * nowhere near clipping.
 */
export const BOX_SOUND_VOLUME = 0.18;

/**
 * The two cue melodies, as [first, second] Hz.
 *
 * Named constants rather than literals at the call sites because the TEST cue plays both
 * pairs, and duplicating the numbers there is exactly how a "test" sound drifts away from
 * the sound it is supposed to be testing.
 *
 * Musically clean perfect fifths, so the cue sounds intentional rather than like a beep:
 * entry G5 -> D6 ascending, exit B5 -> E5 descending.
 */
export const BOX_ENTRY_TONES: readonly [number, number] = [784, 1175];
export const BOX_EXIT_TONES: readonly [number, number] = [988, 659];

/** Envelope shape, in seconds. Attack is short but non-zero, or the tone clicks. */
const TONE_ATTACK_S = 0.015;
/** Release end. A touch longer than the original 0.3 s, which adds presence. */
const TONE_RELEASE_S = 0.36;
const TONE_STOP_S = 0.4;
/** Overlap between the two tones of one cue — connected, not two separate beeps. */
const TONE_GAP_S = 0.08;
/**
 * Silence between the entry cue and the exit cue in the TEST sound.
 *
 * Short, but long enough that they read as two distinct cues rather than one four-note
 * run — the point of the test is to hear the difference.
 */
const TEST_CUE_SEPARATION_S = 0.07;

/** localStorage key for the on/off preference. */
export const BOX_SOUND_STORAGE_KEY = "calspread:box:sound-enabled";

const isDev = (): boolean => {
  try {
    // `DEV` is injected by Vite but not declared on the project's ImportMetaEnv type,
    // so read it through a loose cast rather than widening the global type.
    return (import.meta.env as unknown as { DEV?: boolean } | undefined)?.DEV === true;
  } catch {
    return false;
  }
};

/** Dev-only log; never throws, never noisy in production. */
function debugLog(message: string, err?: unknown): void {
  if (isDev()) console.debug(`[boxSounds] ${message}`, err ?? "");
}

/* --------------------------------- preference -------------------------------- */

/**
 * Parse a stored preference string. Pure and exhaustively testable without a DOM.
 *
 * Defaults to ENABLED: an unset key (first-ever visit) or any unrecognised value means
 * "on". Only an explicit "false" disables — so a corrupted value can never silently mute
 * a feature the user expects.
 */
export function parseStoredBoxSoundPref(raw: string | null): boolean {
  if (raw === null) return true;
  return raw !== "false";
}

export function loadBoxSoundPref(): boolean {
  try {
    return parseStoredBoxSoundPref(localStorage.getItem(BOX_SOUND_STORAGE_KEY));
  } catch {
    // Private-mode / storage-disabled: default to enabled, in memory only.
    return true;
  }
}

export function saveBoxSoundPref(enabled: boolean): void {
  try {
    localStorage.setItem(BOX_SOUND_STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // The toggle still works this session even if it cannot be persisted.
  }
}

/* ------------------------------- audio context ------------------------------- */

let audioContext: AudioContext | null = null;

/** The one shared AudioContext, created on first use. Returns null if unsupported. */
function getAudioContext(): AudioContext | null {
  if (audioContext) return audioContext;
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      debugLog("Web Audio API not available");
      return null;
    }
    audioContext = new Ctor();
    return audioContext;
  } catch (err) {
    debugLog("failed to create AudioContext", err);
    return null;
  }
}

/**
 * One sine tone with a click-free envelope.
 *
 *   attack:  ~15 ms linear ramp from 0 (starting at a non-zero value clicks)
 *   release: exponential decay to near-zero by ~360 ms (musical, no ring-out)
 *
 * exponentialRamp cannot reach 0, so it targets a tiny floor and the node is stopped
 * shortly after.
 */
function playTone(ctx: AudioContext, freq: number, startAt: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, startAt);

  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.linearRampToValueAtTime(BOX_SOUND_VOLUME, startAt + TONE_ATTACK_S);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + TONE_RELEASE_S);

  osc.connect(gain).connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + TONE_STOP_S);
}

/**
 * Play a two-tone cue. Resumes a suspended context first (Chrome suspends until a user
 * gesture), and swallows every error so the caller — the Box UI — is never affected.
 */
function playCue(freq1: number, freq2: number): void {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const start = () => {
      const now = ctx.currentTime;
      playTone(ctx, freq1, now);
      // Second tone overlaps slightly for a connected two-note feel, not two beeps.
      playTone(ctx, freq2, now + TONE_GAP_S);
    };

    if (ctx.state === "suspended") {
      // Resolves once the browser allows audio (after the first user gesture). If it
      // rejects, we simply stay silent.
      void ctx.resume().then(start).catch((err) => debugLog("resume failed", err));
      return;
    }
    start();
  } catch (err) {
    debugLog("playCue failed", err);
  }
}

/** A newly OPENED box: bright RISING confirmation (784 → 1175 Hz). */
export function playBoxEntrySound(): void {
  playCue(BOX_ENTRY_TONES[0], BOX_ENTRY_TONES[1]);
}

/** A CLOSED box: resolving DESCENDING tone (988 → 659 Hz). */
export function playBoxExitSound(): void {
  playCue(BOX_EXIT_TONES[0], BOX_EXIT_TONES[1]);
}

/**
 * Explicitly resume the shared AudioContext.
 *
 * Browsers create the context SUSPENDED and only allow it to start from inside a user
 * gesture (click / tap / key). Event-driven entry and exit cues have no gesture of their
 * own, so on a fresh page load they stay silent until the user interacts. Calling this
 * from a real event handler unlocks the context so those later cues can play. Safe to
 * call repeatedly; swallows every error.
 */
export function unlockBoxAudio(): void {
  try {
    const ctx = getAudioContext();
    if (ctx && ctx.state === "suspended") {
      void ctx.resume().catch((err) => debugLog("unlock resume failed", err));
    }
  } catch (err) {
    debugLog("unlockBoxAudio failed", err);
  }
}

/**
 * Play a short TEST — the entry cue immediately followed by the exit cue — so the user can
 * confirm audio works and hear both distinguishable sounds. Because it runs from a click,
 * it also unlocks the context for later event-driven cues. Deliberately ignores the on/off
 * preference: it is an explicit user action to check the sound.
 */
export function playBoxTestSound(): void {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const play = () => {
      const now = ctx.currentTime;
      // Entry pair (rising), then the exit pair (falling) once it has resolved. Driven by
      // the SAME constants as the real cues, so what you hear when you press Test is
      // exactly what a trade will sound like.
      // The entry pair is finished at gap + stop; leave a beat, then play the exit pair.
      const exitAt = now + TONE_GAP_S + TONE_STOP_S + TEST_CUE_SEPARATION_S;
      playTone(ctx, BOX_ENTRY_TONES[0], now);
      playTone(ctx, BOX_ENTRY_TONES[1], now + TONE_GAP_S);
      playTone(ctx, BOX_EXIT_TONES[0], exitAt);
      playTone(ctx, BOX_EXIT_TONES[1], exitAt + TONE_GAP_S);
    };

    if (ctx.state === "suspended") {
      void ctx.resume().then(play).catch((err) => debugLog("test resume failed", err));
      return;
    }
    play();
  } catch (err) {
    debugLog("playBoxTestSound failed", err);
  }
}
