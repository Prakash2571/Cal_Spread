/**
 * Box trade audio cues — two short, soft, Web-Audio-generated tones.
 *
 * Design goals (from the feature brief): a quiet professional trading-terminal
 * confirmation, not a game or alarm. Entry rises (420→560 Hz), exit falls
 * (500→380 Hz), so the two are instantly distinguishable; both are pure sine, very low
 * gain, under ~450 ms, with smooth ramps so there are no clicks.
 *
 * NON-NEGOTIABLE: playback is completely side-effect-isolated. Every entry point is
 * wrapped so an audio failure — a suspended context, an unsupported browser, autoplay
 * restrictions — can NEVER throw into the Box UI or affect trade processing. On failure
 * it does nothing (and logs only in dev).
 *
 * A single lazily-created AudioContext is reused for the life of the tab; we never
 * construct one per event.
 */

/** Master gain. Deliberately tiny — pleasant on headphones, never startling. */
export const BOX_SOUND_VOLUME = 0.05;

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
 * One soft sine tone with a click-free envelope.
 *
 *   attack:  ~15 ms linear ramp from 0 (starting at a non-zero value clicks)
 *   release: exponential decay to near-zero by ~300 ms (musical, no ring-out)
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
  gain.gain.linearRampToValueAtTime(BOX_SOUND_VOLUME, startAt + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.3);

  osc.connect(gain).connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + 0.34);
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
      playTone(ctx, freq2, now + 0.08);
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

/** A newly OPENED box: soft rising confirmation (420 → 560 Hz). */
export function playBoxEntrySound(): void {
  playCue(420, 560);
}

/** A CLOSED box: soft resolving, warmer descending tone (500 → 380 Hz). */
export function playBoxExitSound(): void {
  playCue(500, 380);
}
