/**
 * What the learner should do next, across every language they have touched.
 *
 * The home screen's whole job is one tap to the right activity, and answering
 * that needs a view the per-language progress hook cannot give: which language
 * was last practised, and how far through it they are.
 *
 * Lives outside `src/activities/` deliberately. That directory is a DOM-free
 * zone — `tsconfig.scripts.json` includes it so Node scripts can import the
 * content sets, which means anything reaching for `localStorage` there breaks
 * the scripts build. This module reads stored progress, so it belongs on the
 * browser side of that line.
 *
 * No new storage. Every attempt already carries an ISO `at`, so "most recently
 * practised" is derivable from what is on disk — which matters, because adding
 * a "last language" key would be a second source of truth for something the
 * data already knows, and the two would drift the first time a learner cleared
 * one and not the other.
 */

import { LANGUAGES } from "../activities/languages/index.js";
import { readProgress } from "../ui/useProgressPersistence.js";
import type { Activity, ActivityProgress } from "../activities/types.js";

export interface NextUp {
  slug: string;
  /** BCP-47 tag, for tagging target-language text (WCAG 3.1.2). */
  code: string;
  label: string;
  activity: Activity;
  /** 1-based position of this activity in the set. */
  position: number;
  total: number;
  passed: number;
  /** ISO timestamp of the most recent attempt, or null if never practised. */
  lastPractisedAt: string | null;
  /** True when every activity in the set has been passed. */
  complete: boolean;
}

/** The latest attempt timestamp in a language's progress, or null. */
function lastAttemptAt(progress: ActivityProgress[]): string | null {
  let latest: string | null = null;
  for (const entry of progress) {
    for (const attempt of entry.attempts) {
      if (typeof attempt.at !== "string") continue;
      if (latest === null || attempt.at > latest) latest = attempt.at;
    }
  }
  return latest;
}

/**
 * The first activity not yet passed, or the last one when all are.
 *
 * Not the stored `index`: that is where the learner stopped, which is not the
 * same as what is left. Someone who exhausted three tries on activity four and
 * advanced has an index of five and an unpassed four — and sending them back
 * to four is right, because it is the thing they have not done.
 */
function firstUnpassed(activities: Activity[], progress: ActivityProgress[]): number {
  const byId = new Map(progress.map((p) => [p.activityId, p]));
  const at = activities.findIndex((a) => byId.get(a.id)?.passed !== true);
  return at === -1 ? activities.length - 1 : at;
}

/** One language's state, or null when it has no activities at all. */
function summarise(
  set: (typeof LANGUAGES)[number],
  learnerName: string | null,
): NextUp | null {
  const stored = readProgress(set.slug, learnerName);
  const index = firstUnpassed(set.activities, stored.progress);
  const activity = set.activities[index];
  if (activity === undefined) return null;

  /**
   * Counted against the activities that currently exist, not against whatever
   * is stored. Content can be removed between releases, and a leftover entry
   * for a deleted activity would otherwise be credited as a pass the learner
   * cannot see — "3 of 10" with only two ticks on the screen.
   */
  const ids = new Set(set.activities.map((a) => a.id));
  const passed = stored.progress.filter((p) => p.passed && ids.has(p.activityId)).length;
  return {
    slug: set.slug,
    code: set.code,
    label: set.label,
    activity,
    position: index + 1,
    total: set.activities.length,
    passed,
    lastPractisedAt: lastAttemptAt(stored.progress),
    complete: passed === set.activities.length,
  };
}

/**
 * The single thing to offer on the home screen, or null on a first visit.
 *
 * Prefers the most recently practised language — resuming is what a learner
 * expects and it is the tap they were going to make anyway. A language they
 * have finished loses to one still in progress, because offering a completed
 * set as "next up" is offering nothing.
 */
export function nextUp(learnerName: string | null): NextUp | null {
  const summaries = LANGUAGES.map((set) => summarise(set, learnerName)).filter(
    (s): s is NextUp => s !== null,
  );

  const started = summaries.filter((s) => s.lastPractisedAt !== null);
  if (started.length === 0) return null;

  const unfinished = started.filter((s) => !s.complete);
  const pool = unfinished.length > 0 ? unfinished : started;

  return pool.reduce((best, candidate) =>
    (candidate.lastPractisedAt ?? "") > (best.lastPractisedAt ?? "") ? candidate : best,
  );
}

/** Every language's state, most recently practised first, for a home list. */
export function allProgress(learnerName: string | null): NextUp[] {
  return LANGUAGES.map((set) => summarise(set, learnerName))
    .filter((s): s is NextUp => s !== null)
    .sort((a, b) => (b.lastPractisedAt ?? "").localeCompare(a.lastPractisedAt ?? ""));
}
