/**
 * The Box sound on/off preference parsing.
 *
 * The localStorage read/write wrappers are thin; the logic worth pinning is the parse —
 * especially that the DEFAULT is enabled (an unset or corrupt value must never silently
 * mute a feature the user expects) and that only an explicit "false" disables.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { parseStoredBoxSoundPref, BOX_SOUND_STORAGE_KEY, BOX_SOUND_VOLUME } from "../src/lib/boxSounds.ts";

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

test("the master volume is low and within the intended range", () => {
  assert.ok(BOX_SOUND_VOLUME > 0 && BOX_SOUND_VOLUME <= 0.08, "must be quiet, not loud");
});
