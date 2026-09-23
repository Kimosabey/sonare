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

import { useCallback, useEffect, useRef } from "react";
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

/**
 * One language's stored progress, without mounting the hook.
 *
 * The home screen has to answer "what were you last doing" across every
 * language, which a per-language hook cannot do — it would mean mounting four
 * of them. Exported rather than duplicated so the key shape and the validation
 * stay in one place: a second copy of `storageKey` is a second thing to
 * remember when the schema version moves.
 */
export function readProgress(slug: string, learnerName: string | null): PersistedProgress {
  return readStored(storageKey(slug, learnerName));
}

/**
 * Writes one language's progress without mounting the hook.
 *
 * Sync needs this: the merged state arrives outside any component's lifecycle,
 * and mounting four hooks to save four languages is not a thing a hook can do.
 */
export function writeProgress(
  slug: string,
  learnerName: string | null,
  next: PersistedProgress,
): void {
  const key = storageKey(slug, learnerName);
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // Private browsing or quota. The session is unaffected.
  }
  /**
   * Announced even when the write threw. A screen showing this language is
   * stale either way — the merged record exists in memory in the caller — and
   * re-reading storage that refused the write simply returns what it already
   * had. Skipping the announcement here would make the notification depend on
   * a storage quota, which is not what it is about.
   */
  announce(key);
}

/**
 * Two records of the same language's progress, combined without losing either.
 *
 * The monotonic rule the server applies and `progressFromWire` repeats:
 * `best` MAX, `passed` OR, `skipped` AND. Monotonic because every one of them
 * only ever moves the way that credits the learner — which is what makes the
 * order the two devices synced in stop mattering.
 *
 * `attempts` comes from `mine`, always. A remote record carries none — the
 * server is never sent them — so taking the other side's would delete the
 * recordings this device made.
 *
 * It lives here rather than in `sync/wire.ts` because this is the module that
 * owns what a progress record *is*. Two definitions of "merged" would be two
 * things to change the day the rule moves, and the symptom of them disagreeing
 * is a learner's passed activity reverting on one screen and not another.
 */
export function mergeProgress(
  mine: readonly ActivityProgress[],
  theirs: readonly ActivityProgress[],
): ActivityProgress[] {
  const byId = new Map(mine.map((p) => [p.activityId, p]));

  for (const entry of theirs) {
    const local = byId.get(entry.activityId);
    if (local === undefined) {
      byId.set(entry.activityId, entry);
      continue;
    }
    byId.set(entry.activityId, {
      activityId: local.activityId,
      attempts: local.attempts,
      best:
        local.best === null
          ? entry.best
          : entry.best === null
            ? local.best
            : Math.max(local.best, entry.best),
      passed: local.passed || entry.passed,
      skipped: local.skipped && entry.skipped,
    });
  }
  return [...byId.values()].sort((a, b) => a.activityId - b.activityId);
}

/**
 * Screens currently showing one language's progress, by storage key.
 *
 * ## Why a write announces itself
 *
 * `writeProgress` is the out-of-band path: sync calls it when a merge lands,
 * from outside any component's lifecycle. A screen that seeded its state at
 * mount has no way to learn that happened, and it saves its own state on every
 * change — so the merged entry was written to storage and then overwritten by
 * the screen moments later, the next time the learner pressed Next. The other
 * device's work vanished from this device's record until a later sync pulled
 * it back.
 *
 * ## Why the hook's own `save` stays silent
 *
 * It must. `save` is a screen writing what it already holds, and notifying
 * would hand it back its own value as news: it would re-read, build a fresh
 * array, set state, and save again, forever. The distinction is not an
 * optimisation — it is the difference between a notification and a loop.
 */
const listeners = new Map<string, Set<() => void>>();

function announce(key: string): void {
  for (const listener of listeners.get(key) ?? []) listener();
}

/**
 * Runs `onChanged` when one language's stored progress is written from outside
 * this screen — which in practice means a sync merged another device's work.
 */
export function useProgressSubscription(
  slug: string,
  learnerName: string | null,
  onChanged: () => void,
): void {
  const key = storageKey(slug, learnerName);
  // A ref so a caller that rebuilds the callback each render does not
  // resubscribe on every render, which would churn the set for no purpose.
  const latest = useRef(onChanged);
  latest.current = onChanged;

  useEffect(() => {
    const listener = (): void => {
      latest.current();
    };
    const set = listeners.get(key) ?? new Set<() => void>();
    set.add(listener);
    listeners.set(key, set);

    return () => {
      set.delete(listener);
      // Emptied rather than left behind: the keys carry a learner name, and a
      // long session that switches learners would otherwise accumulate one
      // dead set per name for the life of the page.
      if (set.size === 0) listeners.delete(key);
    };
  }, [key]);
}

/**
 * Removes one language's stored progress, for a deletion request.
 *
 * The sibling of `clearSkills` and `clearStreak`, and it lives here for the
 * reason those live beside their own readers: the key shape is one thing to
 * remember, and a caller that rebuilt it would silently stop matching the day
 * `SCHEMA_VERSION` moves. Removing the entry rather than writing an empty one,
 * because "deleted" and "present but empty" are not the same claim.
 */
export function clearProgress(slug: string, learnerName: string | null): void {
  try {
    localStorage.removeItem(storageKey(slug, learnerName));
  } catch {
    // Best effort — the same tolerance every other access here has.
  }
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
