/**
 * Wires the pure BoxSoundTracker to React state, the localStorage preference, and the
 * audio helpers — so Box.tsx only has to say "here are the open ids" / "this one exited"
 * and render the toggle.
 *
 * The notify callbacks are STABLE (empty deps) so they can be captured once inside the
 * SSE effect's interval and event listeners without going stale. They read the latest
 * enabled flag through a ref rather than closing over the state value.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  loadBoxSoundPref,
  saveBoxSoundPref,
  playBoxEntrySound,
  playBoxExitSound,
} from "./lib/boxSounds.ts";
import { BoxSoundTracker } from "./lib/boxSoundTracker.ts";

export interface BoxSoundsApi {
  soundEnabled: boolean;
  toggleSound: () => void;
  /** Report the current OPEN trade ids from a snapshot frame. */
  notifyOpenSnapshot: (openIds: string[]) => void;
  /** Report a closed trade id from the `exit` event. */
  notifyExit: (tradeId: string) => void;
}

export function useBoxSounds(): BoxSoundsApi {
  const [soundEnabled, setSoundEnabled] = useState<boolean>(loadBoxSoundPref);

  // Latest enabled flag for the stable callbacks below.
  const enabledRef = useRef(soundEnabled);
  useEffect(() => {
    enabledRef.current = soundEnabled;
  }, [soundEnabled]);

  // One tracker per mount. A remount gives a fresh instance, so the first snapshot
  // after remounting is treated as baseline again.
  const trackerRef = useRef<BoxSoundTracker | null>(null);
  if (trackerRef.current === null) trackerRef.current = new BoxSoundTracker();

  const toggleSound = useCallback(() => {
    setSoundEnabled((prev) => {
      const next = !prev;
      saveBoxSoundPref(next);
      return next;
    });
  }, []);

  const notifyOpenSnapshot = useCallback((openIds: string[]) => {
    // Always feed the tracker, even when muted: it must keep an accurate baseline so
    // that re-enabling mid-session does not replay everything already open.
    const newlyOpened = trackerRef.current!.observeOpenSnapshot(openIds);
    if (newlyOpened.length > 0 && enabledRef.current) {
      // A failed sound must never reach the Box UI — the helper is already isolated,
      // this is belt-and-braces.
      try {
        playBoxEntrySound();
      } catch {
        /* never surface audio errors */
      }
    }
  }, []);

  const notifyExit = useCallback((tradeId: string) => {
    const isNew = trackerRef.current!.observeExit(tradeId);
    if (isNew && enabledRef.current) {
      try {
        playBoxExitSound();
      } catch {
        /* never surface audio errors */
      }
    }
  }, []);

  return { soundEnabled, toggleSound, notifyOpenSnapshot, notifyExit };
}
