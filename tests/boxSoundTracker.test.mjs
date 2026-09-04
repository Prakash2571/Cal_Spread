/**
 * The Box sound decision logic: hydration, deduplication and transition detection.
 *
 * These are the properties the feature brief calls critical — a page that loads with
 * trades already open/closed must stay silent, repeated SSE frames must not replay a
 * sound, and only genuine transitions after the baseline should fire. All pure, no audio.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BoxSoundTracker } from "../src/lib/boxSoundTracker.ts";

/* -------------------------------- hydration -------------------------------- */

test("the FIRST snapshot is baseline and plays nothing, however many are open", () => {
  const t = new BoxSoundTracker();
  // 3 open trades already present on page load.
  assert.deepEqual(t.observeOpenSnapshot(["a", "b", "c"]), []);
  assert.equal(t.isHydrated, true);
});

test("an exit before hydration is ignored", () => {
  const t = new BoxSoundTracker();
  assert.equal(t.observeExit("x"), false);
});

/* ---------------------------------- entry ---------------------------------- */

test("a trade that newly appears after baseline plays entry once", () => {
  const t = new BoxSoundTracker();
  t.observeOpenSnapshot(["a", "b"]); // baseline
  assert.deepEqual(t.observeOpenSnapshot(["a", "b", "c"]), ["c"], "c is new");
});

test("a repeated snapshot with the same open set plays nothing (dedupe)", () => {
  const t = new BoxSoundTracker();
  t.observeOpenSnapshot(["a"]); // baseline
  t.observeOpenSnapshot(["a", "b"]); // b opens
  // The same frame arriving 5 more times (SSE cadence / reconnect) must be silent.
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(t.observeOpenSnapshot(["a", "b"]), []);
  }
});

test("two trades opening in one frame both count", () => {
  const t = new BoxSoundTracker();
  t.observeOpenSnapshot([]); // baseline: nothing open
  assert.deepEqual(t.observeOpenSnapshot(["a", "b"]).sort(), ["a", "b"]);
});

test("a trade leaving then a DIFFERENT one arriving only sounds for the new one", () => {
  const t = new BoxSoundTracker();
  t.observeOpenSnapshot(["a"]); // baseline
  assert.deepEqual(t.observeOpenSnapshot([]), [], "a closed — no entry sound");
  assert.deepEqual(t.observeOpenSnapshot(["b"]), ["b"], "b is genuinely new");
});

test("empty and falsy ids are ignored", () => {
  const t = new BoxSoundTracker();
  t.observeOpenSnapshot([]); // baseline
  assert.deepEqual(t.observeOpenSnapshot(["", "real"]), ["real"]);
});

/* ----------------------------------- exit ---------------------------------- */

test("a closed trade after hydration plays exit exactly once", () => {
  const t = new BoxSoundTracker();
  t.observeOpenSnapshot(["a"]); // hydrate
  assert.equal(t.observeExit("a"), true);
  // The same exit id repeating (reconnect / duplicate frame) is silent.
  assert.equal(t.observeExit("a"), false);
  assert.equal(t.observeExit("a"), false);
});

test("distinct exits each sound once", () => {
  const t = new BoxSoundTracker();
  t.observeOpenSnapshot([]); // hydrate
  assert.equal(t.observeExit("a"), true);
  assert.equal(t.observeExit("b"), true);
  assert.equal(t.observeExit("a"), false);
});

/* --------------------------------- remount --------------------------------- */

test("reset() makes the next snapshot a fresh baseline", () => {
  const t = new BoxSoundTracker();
  t.observeOpenSnapshot(["a"]);
  t.observeOpenSnapshot(["a", "b"]); // b opened
  t.reset();
  assert.equal(t.isHydrated, false);
  // After a remount, the trades already open are baseline again — no sounds.
  assert.deepEqual(t.observeOpenSnapshot(["a", "b"]), []);
  // And a previously-sounded exit is allowed to sound again in the new session.
  assert.equal(t.observeExit("a"), true);
});
