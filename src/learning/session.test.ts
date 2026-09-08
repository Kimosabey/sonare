/**
 * Three off-by-one decisions that used to be testable only by rendering a
 * screen: did that pass, was it a personal best, and has this learner run out
 * of tries.
 *
 * R8 runs through all of them. An indeterminate take is one the system
 * declined to judge, so it must never pass, never burn a try, and never be
 * celebrated — and each of those is a separate place to get it wrong.
 *
 * The pass mark and the attempt limit are imported rather than hardcoded, so
 * these read as "the rule" rather than "sixty" and a change to either moves
 * the tests with it.
 */

import { describe, expect, it } from "vitest";
import { MAX_ATTEMPTS, PASS_SCORE } from "../activities/languages/index.js";
import {
  applySkip,
  applyTake,
  bestOf,
  canAdvanceFrom,
  celebrationFor,
  scoredAttemptsOf,
  stepStateFor,
} from "./session.js";
import type { ActivityAttempt, ActivityProgress } from "../activities/types.js";

function attempt(accuracy: number | null, at = "2026-09-07T10:00:00.000Z"): ActivityAttempt {
  return { activityId: 1, result: {} as never, accuracy, at };
}

/** Progress for activity 1 built by replaying `accuracies` in order. */
function after(accuracies: Array<number | null>): ActivityProgress[] {
  return accuracies.reduce<ActivityProgress[]>(
    (progress, accuracy) => applyTake(progress, 1, attempt(accuracy)),
    [],
  );
}

function entry(progress: ActivityProgress[]): ActivityProgress {
  const found = progress[0];
  if (found === undefined) throw new Error("expected an entry");
  return found;
}

describe("the best score", () => {
  it("is the highest measured attempt", () => {
    expect(bestOf([attempt(41), attempt(68), attempt(52)])).toBe(68);
  });

  it("is null when nothing was measured", () => {
    /**
     * Null is not zero. Zero is a score a learner could earn; null means
     * nothing was measured, and conflating them would make an indeterminate
     * take read as a catastrophic one.
     */
    expect(bestOf([])).toBeNull();
    expect(bestOf([attempt(null), attempt(null)])).toBeNull();
  });

  it("ignores indeterminate attempts without losing the measured ones", () => {
    expect(bestOf([attempt(null), attempt(55), attempt(null)])).toBe(55);
  });

  it("keeps a genuine zero", () => {
    expect(bestOf([attempt(0)])).toBe(0);
  });
});

describe("counting tries", () => {
  it("counts only the attempts that produced a number", () => {
    /**
     * The rule R8 exists for. An indeterminate take does not burn a try,
     * because the learner was never measured — charging them for it would be
     * punishing our own failure.
     */
    expect(scoredAttemptsOf([attempt(40), attempt(null), attempt(50)])).toBe(2);
  });

  it("is zero for a learner who has only had unusable takes", () => {
    expect(scoredAttemptsOf([attempt(null), attempt(null), attempt(null)])).toBe(0);
  });
});

describe("when a learner may move on", () => {
  it("cannot from an activity never attempted", () => {
    expect(canAdvanceFrom(undefined)).toBe(false);
  });

  it("cannot from an entry that exists but has no takes", () => {
    // Reachable through applySkip, which records an entry with zero attempts.
    // `after([])` would be the obvious way to build one and returns an empty
    // list instead — there is no entry until a take folds in.
    expect(canAdvanceFrom(entry(applySkip([], 1)))).toBe(false);
  });

  it("can once they have passed", () => {
    expect(canAdvanceFrom(entry(after([PASS_SCORE])))).toBe(true);
  });

  it("cannot on the last try before the limit", () => {
    // The off-by-one that decides whether a learner gets their third go.
    const nearly = Array.from({ length: MAX_ATTEMPTS - 1 }, () => 40);

    expect(canAdvanceFrom(entry(after(nearly)))).toBe(false);
  });

  it("can once the scored tries are exhausted", () => {
    const exhausted = Array.from({ length: MAX_ATTEMPTS }, () => 40);

    expect(canAdvanceFrom(entry(after(exhausted)))).toBe(true);
  });

  it("is not brought closer by indeterminate takes", () => {
    /**
     * The case that would silently cost a learner their session: a run of
     * unusable takes must leave all three tries intact.
     */
    const unusable = Array.from({ length: MAX_ATTEMPTS * 2 }, () => null);

    expect(canAdvanceFrom(entry(after(unusable)))).toBe(false);
  });
});

describe("folding in an attempt", () => {
  it("records the first attempt for an activity", () => {
    const progress = after([55]);

    expect(entry(progress)).toMatchObject({ activityId: 1, best: 55, passed: false, skipped: false });
    expect(entry(progress).attempts).toHaveLength(1);
  });

  it("appends to an activity already attempted, rather than replacing it", () => {
    const progress = after([41, 52, 68]);

    expect(entry(progress).attempts.map((a) => a.accuracy)).toEqual([41, 52, 68]);
  });

  it("leaves other activities alone", () => {
    const progress = applyTake(applyTake([], 1, attempt(50)), 2, attempt(90));

    expect(progress.map((p) => p.activityId)).toEqual([1, 2]);
    expect(progress[0]?.best).toBe(50);
  });

  it("passes at the mark, not above it", () => {
    // Whether the pass is `>=` or `>` decides the outcome of every borderline
    // take, and a learner scoring exactly the mark has met it.
    expect(entry(after([PASS_SCORE])).passed).toBe(true);
    expect(entry(after([PASS_SCORE - 1])).passed).toBe(false);
  });

  it("keeps a pass after a later worse attempt", () => {
    /**
     * `passed` comes from the best, not from this take. A learner who passed
     * on their second try and then scored badly on a third has still passed —
     * anything else would punish them for practising.
     */
    const progress = after([PASS_SCORE + 20, 20]);

    expect(entry(progress).passed).toBe(true);
    expect(entry(progress).best).toBe(PASS_SCORE + 20);
  });

  it("never passes on an indeterminate take", () => {
    expect(entry(after([null])).passed).toBe(false);
    expect(entry(after([null, null, null])).passed).toBe(false);
  });

  it("marks an activity skipped once the tries run out without a pass", () => {
    const exhausted = Array.from({ length: MAX_ATTEMPTS }, () => 40);

    expect(entry(after(exhausted)).skipped).toBe(true);
  });

  it("does not mark a passed activity skipped", () => {
    const progress = after([40, 40, PASS_SCORE]);

    expect(entry(progress)).toMatchObject({ passed: true, skipped: false });
  });

  it("does not let indeterminate takes mark an activity skipped", () => {
    // The same off-by-one as the advance rule, in the field the report reads.
    const unusable = Array.from({ length: MAX_ATTEMPTS * 2 }, () => null);

    expect(entry(after(unusable)).skipped).toBe(false);
  });
});

describe("skipping without recording", () => {
  it("records zero attempts and a skip", () => {
    /**
     * Different from failing three times, and the report needs to tell them
     * apart: a learner on a bus has not failed anything.
     */
    const progress = applySkip([], 1);

    expect(entry(progress)).toEqual({
      activityId: 1,
      attempts: [],
      best: null,
      passed: false,
      skipped: true,
    });
  });

  it("does not overwrite an activity that already has takes", () => {
    // Otherwise a mis-tap would discard a real result.
    const withTake = after([68]);

    expect(applySkip(withTake, 1)).toEqual(withTake);
  });

  it("leaves other activities alone", () => {
    const progress = applySkip(after([50]), 2);

    expect(progress.map((p) => p.activityId)).toEqual([1, 2]);
  });
});

describe("what to celebrate", () => {
  it("says nothing about an indeterminate take", () => {
    /**
     * The motion spec's hardest rule, as a pure function. Confetti over an
     * unmeasured result is a fabricated verdict wearing an animation — it
     * tells a learner they succeeded at something the system explicitly
     * declined to judge.
     */
    expect(celebrationFor({ accuracy: null, previousBest: null, isFirstAttempt: true })).toBeNull();
    expect(celebrationFor({ accuracy: null, previousBest: 90, isFirstAttempt: false })).toBeNull();
  });

  it("says nothing about a take below the mark", () => {
    expect(
      celebrationFor({ accuracy: PASS_SCORE - 1, previousBest: null, isFirstAttempt: true }),
    ).toBeNull();
  });

  it("calls a first-try pass exactly that", () => {
    expect(celebrationFor({ accuracy: 88, previousBest: null, isFirstAttempt: true })).toEqual({
      kind: "firstTry",
      score: 88,
    });
  });

  it("calls a beaten best a personal best", () => {
    expect(celebrationFor({ accuracy: 90, previousBest: 65, isFirstAttempt: false })).toEqual({
      kind: "personalBest",
      score: 90,
    });
  });

  it("does not claim a personal best for a pass that beat nothing", () => {
    // Otherwise every subsequent pass is a personal best, and the label stops
    // meaning anything.
    expect(celebrationFor({ accuracy: 70, previousBest: 90, isFirstAttempt: false })).toEqual({
      kind: "pass",
      score: 70,
    });
  });

  it("does not claim one for equalling a previous best", () => {
    // Equalling is not beating.
    expect(celebrationFor({ accuracy: 80, previousBest: 80, isFirstAttempt: false })?.kind).toBe("pass");
  });

  it("treats a first pass after unusable takes as a personal best, not a first try", () => {
    /**
     * The subtle one. "First try" is about the learner's first *attempt*, and
     * somebody whose first two takes were unusable is not on their first
     * attempt — but they have no previous best either, so the honest label is
     * the one that does not claim they got it right first time.
     */
    expect(celebrationFor({ accuracy: 88, previousBest: null, isFirstAttempt: false })?.kind).toBe(
      "personalBest",
    );
  });
});

describe("the progress rail", () => {
  it("marks where the learner is, above everything else", () => {
    /**
     * A learner who passed an activity and came back to beat their own score
     * should still see it marked as where they are.
     */
    const passed = entry(after([PASS_SCORE]));

    expect(stepStateFor(true, passed)).toBe("current");
  });

  it("marks a passed activity", () => {
    expect(stepStateFor(false, entry(after([PASS_SCORE])))).toBe("passed");
  });

  it("marks a skipped one", () => {
    expect(stepStateFor(false, entry(applySkip([], 1)))).toBe("skipped");
  });

  it("marks an untouched one as upcoming", () => {
    expect(stepStateFor(false, undefined)).toBe("upcoming");
  });

  it("prefers passed over skipped when both are somehow set", () => {
    // Cannot happen through applyTake, but the rail must not show a passed
    // activity as skipped if it ever did.
    const both: ActivityProgress = {
      activityId: 1,
      attempts: [],
      best: 90,
      passed: true,
      skipped: true,
    };

    expect(stepStateFor(false, both)).toBe("passed");
  });
});
