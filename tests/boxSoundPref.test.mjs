/**
 * The Box sound on/off preference parsing.
 *
 * The localStorage read/write wrappers are thin; the logic worth pinning is the parse —
 * especially that the DEFAULT is enabled (an unset or corrupt value must never silently
 * mute a feature the user expects) and that only an explicit "false" disables.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  parseStoredBoxSoundPref,
  BOX_SOUND_STORAGE_KEY,
  BOX_SOUND_VOLUME,
  BOX_ENTRY_TONES,
  BOX_EXIT_TONES,
} from "../src/lib/boxSounds.ts";

test("an unset preference defaults to ENABLED", () => {
  assert.equal(parseStoredBoxSoundPref(null), true);
});

test('only an explicit "false" disables', () => {
  assert.equal(parseStoredBoxSoundPref("false"), false);
  assert.equal(parseStoredBoxSoundPref("true"), true);
});

test("an unrecognised or corrupt value falls back to ENABLED, never mute", () => {
  for (const raw of ["", "0", "nope", "TRUE", "off"]) {
    assert.equal(parseStoredBoxSoundPref(raw), true, `"${raw}" must not disable`);
  }
});

test("the storage key matches the documented contract", () => {
  assert.equal(BOX_SOUND_STORAGE_KEY, "calspread:box:sound-enabled");
});

test("the master volume is clearly audible but leaves headroom", () => {
  // Raised from 0.05 on purpose: the original cue was so quiet it was easy to miss, which
  // defeats the point of a trade alert. The upper bound matters because the two tones of a
  // cue OVERLAP, so the instantaneous peak can approach 2x this — it must stay well clear
  // of clipping at 1.0.
  assert.ok(BOX_SOUND_VOLUME >= 0.12, "must be loud enough to notice");
  assert.ok(BOX_SOUND_VOLUME <= 0.35, "must leave headroom: two overlapping tones can peak at 2x");
});

test("entry RISES and exit FALLS — the property that tells them apart", () => {
  // This is the whole reason there are two cues. Someone re-tuning the pitch must not
  // accidentally make both ascend.
  assert.ok(BOX_ENTRY_TONES[1] > BOX_ENTRY_TONES[0], "an opened box must rise");
  assert.ok(BOX_EXIT_TONES[1] < BOX_EXIT_TONES[0], "a closed box must fall");
});

test("the two cues start on DIFFERENT notes, so the first instant identifies which it is", () => {
  assert.notEqual(BOX_ENTRY_TONES[0], BOX_EXIT_TONES[0]);
});

test("the tones sit in the band the ear is most sensitive to", () => {
  // Pitched up roughly an octave from the original 380-560 Hz. The equal-loudness curves
  // are worth ~8-10 dB here, so this carries much further at the same gain — half of why
  // the cue is now easy to notice.
  for (const hz of [...BOX_ENTRY_TONES, ...BOX_EXIT_TONES]) {
    assert.ok(hz >= 600 && hz <= 1400, `${hz} Hz should be in the 600-1400 Hz range`);
  }
});
