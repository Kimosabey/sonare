/**
 * The rules that decide what an attempt did. Pure, no React, no I/O.
 *
 * These lived inline in `ActivityTest`, a 792-line component, which meant the
 * arithmetic behind "did that pass", "was that a personal best" and "has this
 * learner run out of tries" could only be exercised by rendering a screen with
 * a mocked recorder and reading the DOM. That is a poor way to test three
 * off-by-one decisions, and off-by-one is exactly what they are.
 *
 * Extracting the *logic* rather than the *layout* is a deliberate departure
 * from the plan, which asked for the screen to be split into three routed
 * steps. Routing recorder state through navigation lets the two desync on the
 * one screen where R8 and the three-attempt count live, and the motion spec
 * forbids animating the record step anyway — so that split would have traded a
 * real safety property for nothing.
 *
 * One thing this does *not* do, recorded because I claimed otherwise before
 * measuring: it barely shortens `ActivityTest`. The file went from 792 lines
 * to 791. Its length is comments and JSX, not arithmetic. What the move buys
 * is that these rules are now tested directly — thirty-six cases over
 * decisions that previously could only be reached by rendering a screen with
 * a mocked recorder and reading the DOM. That is worth having on its own, and
 * it is not the same thing as paying down the length.
 *
 * R8 runs through all of it. An indeterminate take is a take the system
 * declined to judge, so it must never pass, never count against the three
 * tries, and never be celebrated.
 */

import { MAX_ATTEMPTS, PASS_SCORE } from "../activities/languages/index.js";
import type { ActivityAttempt, ActivityProgress } from "../activities/types.js";

/**
 * The best accuracy across attempts, or null if none was ever measured.
 *
 * Null is not zero. Zero is a score a learner could earn; null means nothing
 * was measured, and treating them alike would let an indeterminate take read
 * as a catastrophic one.
 */
export function bestOf(attempts: ActivityAttempt[]): number | null {
  return attempts.reduce<number | null>(
    (acc, a) => (a.accuracy === null ? acc : acc === null ? a.accuracy : Math.max(acc, a.accuracy)),
    null,
  );
}

/**
 * Attempts that produced a number.
 *
 * The figure the three-try limit counts, and the reason it is not
 * `attempts.length`: an indeterminate take does not burn a try, because the
 * learner was never measured and charging them for it would be punishing our
 * own failure (R8).
 */
export function scoredAttemptsOf(attempts: ActivityAttempt[]): number {
  return attempts.filter((a) => a.accuracy !== null).length;
}

/** Whether the learner may move on: passed, or out of scored tries. */
export function canAdvanceFrom(current: ActivityProgress | undefined): boolean {
  if (current === undefined) return false;
  return current.passed || scoredAttemptsOf(current.attempts) >= MAX_ATTEMPTS;
}

/**
 * Folds one attempt into a language's progress.
 *
 * `passed` is derived from the *best* rather than from this attempt, so a
 * learner who passed on their second try and then scored badly on a third
 * keeps the pass. `skipped` means advanced without passing, which is only
 * true once the scored tries are exhausted.
 */
export function applyTake(
  progress: ActivityProgress[],
  activityId: number,
  attempt: ActivityAttempt,
): ActivityProgress[] {
  const existing = progress.find((p) => p.activityId === activityId);
  const attempts = [...(existing?.attempts ?? []), attempt];
  const best = bestOf(attempts);
  const passed = best !== null && best >= PASS_SCORE;

  const next: ActivityProgress = {
    activityId,
    attempts,
    best,
    passed,
    skipped: !passed && scoredAttemptsOf(attempts) >= MAX_ATTEMPTS,
  };

  return existing !== undefined
    ? progress.map((p) => (p.activityId === activityId ? next : p))
    : [...progress, next];
}

/**
 * Records that a learner moved on without recording anything.
 *
 * Zero attempts and `skipped`, which is different from failing three times:
 * the report can then tell "could not speak right now" apart from "tried and
 * did not reach the mark", and a learner on a bus has not failed anything.
 */
export function applySkip(progress: ActivityProgress[], activityId: number): ActivityProgress[] {
  if (progress.some((p) => p.activityId === activityId)) return progress;
  return [...progress, { activityId, attempts: [], best: null, passed: false, skipped: true }];
}

export type CelebrationKind = "pass" | "personalBest" | "firstTry";

export interface Celebration {
  kind: CelebrationKind;
  score: number;
}

/**
 * What to celebrate, if anything.
 *
 * Null for an indeterminate take, and that is the rule the motion spec cares
 * most about: confetti over an unmeasured result is a fabricated verdict
 * wearing an animation — it tells a learner they succeeded at something the
 * system explicitly declined to judge.
 *
 * `previousBest` is the best as it stood *immediately before* this attempt,
 * not the current best. The current one has already absorbed this attempt by
 * the time anything renders, which would make every take look like a gain of
 * zero.
 */
export function celebrationFor(options: {
  accuracy: number | null;
  previousBest: number | null;
  isFirstAttempt: boolean;
}): Celebration | null {
  const { accuracy, previousBest, isFirstAttempt } = options;

  // Not measured, or not a pass. Neither is a thing to celebrate.
  if (accuracy === null || accuracy < PASS_SCORE) return null;

  if (isFirstAttempt) return { kind: "firstTry", score: accuracy };
  if (previousBest === null || accuracy > previousBest) {
    return { kind: "personalBest", score: accuracy };
  }
  return { kind: "pass", score: accuracy };
}

/** The state of one activity for the progress rail. */
export type StepState = "current" | "passed" | "skipped" | "upcoming";

/**
 * `current` wins over everything.
 *
 * A learner looking at the activity they are on should see it marked as where
 * they are, even if they have already passed it and come back to beat their
 * own score.
 */
export function stepStateFor(
  isCurrent: boolean,
  entry: ActivityProgress | undefined,
): StepState {
  if (isCurrent) return "current";
  if (entry?.passed === true) return "passed";
  if (entry?.skipped === true) return "skipped";
  return "upcoming";
}
