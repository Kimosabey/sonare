/**
 * Persists per-language activity progress across a refresh, keyed by learner
 * + language slug — same localStorage-plus-fallback pattern useLearnerName.ts
 * and Diagnostics.tsx already use. This is deliberately outside src/speech/:
 * R11 keeps the *capture* layer's state in-memory only (a stale audio config
 * surviving a reload is the kind of bug that's indistinguishable from a real
 * platform finding), but the learner's activity progress isn't capture state,
 * and losing a whole session to an accidental refresh is a real cost now that
 * this is the shipped product, not just the fixture runner.
 */

import { useCallback, useRef } from "react";
import type { ActivityProgress } from "../activities/types.js";

export interface PersistedProgress {
  index: number;
  progress: ActivityProgress[];
  finished: boolean;
}

const EMPTY: PersistedProgress = { index: 0, progress: [], finished: false };

/**
 * Bumped whenever the persisted shape changes in a way older data cannot
 * satisfy. It is part of the key, so a bump orphans the old entry rather than
 * reading it — the learner starts that language fresh, which is a far smaller
 * cost than the alternative.
 *
 * v2: `ScoredWord.syllables` became required. A v1 entry restores results
 * whose words have no `syllables` at all, and report.ts crashed on
 * "word.syllables is not iterable" the moment a saved session was reopened.
 * The consuming loops now guard as well — two defences, because a type cannot
 * make a claim about JSON that was written before the type existed.
 */
const SCHEMA_VERSION = "v2";

function storageKey(slug: string, learnerName: string | null): string {
  return `sonare.progress.${SCHEMA_VERSION}.${slug}.${learnerName ?? "anonymous"}`;
}

function readStored(key: string): PersistedProgress {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<PersistedProgress>;
    return {
      index: typeof parsed.index === "number" ? parsed.index : 0,
      progress: Array.isArray(parsed.progress) ? parsed.progress : [],
      finished: parsed.finished === true,
    };
  } catch {
    // Private browsing, storage disabled, or a corrupt value — start fresh
    // rather than fail the page over a convenience feature.
    return EMPTY;
  }
}

export interface UseProgressPersistenceValue {
  /** Read once, at mount — the caller seeds its own state from this. */
  initial: PersistedProgress;
  save: (next: PersistedProgress) => void;
  clear: () => void;
}

export function useProgressPersistence(slug: string, learnerName: string | null): UseProgressPersistenceValue {
  const key = storageKey(slug, learnerName);
  // A ref, not state: this is read exactly once, to seed the caller's own
  // useState calls — re-reading on every render would fight the caller's
  // subsequent updates instead of just seeding them.
  const initial = useRef(readStored(key));

  const save = useCallback(
    (next: PersistedProgress) => {
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Still works for the rest of this visit via in-memory state; it
        // just won't survive a refresh.
      }
    },
    [key],
  );

  const clear = useCallback(() => {
    try {
      localStorage.removeItem(key);
    } catch {
      // Best-effort — the in-memory reset the caller does still happens.
    }
  }, [key]);

  return { initial: initial.current, save, clear };
}
