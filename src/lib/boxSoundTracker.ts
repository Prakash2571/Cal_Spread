/**
 * Decides WHEN a Box sound should fire, from the trade state the frontend already has.
 *
 * Pure and free of React, audio and DOM, so the tricky parts — hydration and
 * deduplication — are exhaustively unit-testable. It makes decisions only; the caller
 * plays the sound.
 *
 * ENTRY is driven by the live SSE `snapshot.open_trades` set: a trade id present now that
 * was not present before is a new open.
 *
 * EXIT is driven by the discrete SSE `exit` event, which the backend emits only on a real
 * exit execution (never on connect, never on a delete). Deduplicated by trade id.
 *
 * THE HYDRATION RULE. The first open snapshot is BASELINE, not news: a page that loads
 * with three boxes already open must not play three entry sounds. Only transitions after
 * that baseline count. Exit events are inherently live-only, but are still gated on
 * hydration and deduped so a reconnect or a repeated frame can never replay one.
 */
export class BoxSoundTracker {
  /** Trade ids currently believed open. Small — bounded by max concurrent boxes. */
  private knownOpen = new Set<string>();
  /** Exit ids already sounded, so a repeat/reconnect cannot replay them. */
  private soundedExit = new Set<string>();
  private hydrated = false;

  /** True once the baseline snapshot has been absorbed. */
  get isHydrated(): boolean {
    return this.hydrated;
  }

  /**
   * Feed the current set of OPEN trade ids (from a snapshot frame).
   *
   * Returns the ids that just opened and should play the entry sound — empty on the
   * baseline snapshot and empty for any id already known. The caller passes the result
   * to `playBoxEntrySound()` (once per id, though today it just needs "at least one").
   */
  observeOpenSnapshot(openIds: Iterable<string>): string[] {
    const current = new Set<string>();
    for (const id of openIds) if (id) current.add(id);

    if (!this.hydrated) {
      // Baseline: adopt silently.
      this.knownOpen = current;
      this.hydrated = true;
      return [];
    }

    const newlyOpened: string[] = [];
    for (const id of current) {
      if (!this.knownOpen.has(id)) newlyOpened.push(id);
    }
    // Replace wholesale so a closed/deleted trade leaves the set; ids are unique per
    // trade and never reused, so a departed id cannot re-trigger later.
    this.knownOpen = current;
    return newlyOpened;
  }

  /**
   * Feed a closed trade id from the `exit` event. Returns true exactly once per id, and
   * only after hydration — so historical closes and reconnect replays stay silent.
   */
  observeExit(tradeId: string): boolean {
    if (!tradeId) return false;
    if (!this.hydrated) return false;
    if (this.soundedExit.has(tradeId)) return false;
    this.soundedExit.add(tradeId);
    return true;
  }

  /** Forget everything, so the next snapshot becomes a fresh baseline (on remount). */
  reset(): void {
    this.knownOpen.clear();
    this.soundedExit.clear();
    this.hydrated = false;
  }
}
