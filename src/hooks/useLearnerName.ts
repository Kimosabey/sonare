/**
 * Asked once, on first use, then remembered — same localStorage-plus-fallback
 * pattern Diagnostics.tsx already uses for its access token.
 *
 * ── why the name is shared between every caller ─────────────────────────────
 *
 * This started as plain `useState`, which gives each caller its own copy. That
 * was fine while the name was only ever set on the way in, on a screen nothing
 * else was mounted beside. The You tab breaks it: switching learner there has
 * to reach `Shell`, which holds the name it passes to `useSync`, and `Today`,
 * which reads every store through it.
 *
 * With per-caller copies, a switch updates the screen that made it and nothing
 * else — so the sync loop would keep pushing the *previous* learner's dirty
 * flags under the previous learner's token until something happened to remount
 * the app. On a shared tablet that is two people's records crossing, which is
 * the exact bug the per-learner keying in learnerId.ts and tokenStore.ts was
 * introduced to fix. A switch has to be one event, not one per component.
 *
 * So a set of subscribers, and the setter notifies all of them. Storage stays
 * the source of truth for a *reload*; this is the source of truth for the
 * lifetime of one page, which is what makes the name reported after a failed
 * write still correct (see the tests).
 */

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "sonare.learnerName";

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private browsing or storage disabled — falls back to asking every visit.
    return null;
  }
}

/**
 * Every mounted caller, so one switch is one event.
 *
 * Module scope, which is what makes it shared. Each caller removes its own
 * listener on unmount, so this does not grow with navigation.
 */
const listeners = new Set<(name: string | null) => void>();

export function useLearnerName(): [string | null, (name: string) => void] {
  const [name, setNameState] = useState<string | null>(readStored);

  useEffect(() => {
    const listener = (next: string | null): void => setNameState(next);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const setName = useCallback((next: string) => {
    /**
     * State before storage, and via the listener set rather than directly.
     *
     * The caller's own listener is in that set, so this still reports the new
     * name synchronously — which the language picker needs, because it
     * navigates on set. Going through the set rather than calling
     * `setNameState` as well is what stops the two paths from being able to
     * disagree.
     */
    for (const listener of listeners) listener(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Still works for the rest of this visit via state; just won't be
      // remembered next time.
    }
  }, []);

  return [name, setName];
}
