/**
 * The microphone level, kept out of React state.
 *
 * The capture layer emits a level 30 times a second for the whole of a take
 * (LEVEL_INTERVAL_MS). Held in `useState` inside useRecorder, every one of
 * those emissions re-rendered whichever page owns the recorder — ActivityTest
 * is ~500 lines of JSX — thirty times a second, on the exact frames the
 * recording UI most needs to stay smooth.
 *
 * Memoising the children already stopped them re-rendering, but the page's own
 * body still had to run and rebuild its element tree each tick. An external
 * store fixes the remaining half: the page never re-renders at all, and only
 * the two leaves that actually display a level subscribe.
 *
 * Deliberately not a class and free of `this` — `subscribe` and `getSnapshot`
 * are handed straight to useSyncExternalStore, which calls them unbound.
 */

const SILENT_DBFS = -90;

export interface LevelStore {
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => number;
  /** Called from the capture layer's frame callback, never from React. */
  set: (dbfs: number) => void;
  /** Back to silence between takes, so a stale level never lingers. */
  reset: () => void;
}

export function createLevelStore(): LevelStore {
  let value = SILENT_DBFS;
  const listeners = new Set<() => void>();

  const emit = (next: number): void => {
    // useSyncExternalStore compares snapshots by identity, so an unchanged
    // number costs nothing — but skipping the notify avoids waking every
    // subscriber to discover that.
    if (next === value) return;
    value = next;
    for (const listener of listeners) listener();
  };

  return {
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    getSnapshot: () => value,
    set: emit,
    reset: () => emit(SILENT_DBFS),
  };
}
