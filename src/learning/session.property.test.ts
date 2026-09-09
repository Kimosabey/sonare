/**
 * T33 — the three-attempt gate, swept rather than sampled.
 *
 * `session.test.ts` next door is thirty-six hand-written cases, and they are
 * the right thirty-six: each one names a decision and pins it. What they
 * cannot do is state a rule about *every* sequence of takes a learner could
 * produce, and the three bugs this module was extracted to prevent were all
 * off-by-ones — the class of bug that hides in the one sequence nobody thought
 * to write down.
 *
 * So this file asserts invariants over generated histories instead of
 * outcomes over chosen ones. The generators come from src/testing/rng.ts and
 * are seeded with literals, so a failure here is reproducible: it prints the
 * seed and the case index, and re-running gives the identical history.
 *
 * The invariant that matters most is R8. An indeterminate take is one the
 * system declined to judge, so across every generated history the pair
 * "history with the unusable takes" and "history with them removed" must be
 * indistinguishable in every respect a learner can feel: the same best, the
 * same pass, the same skip, the same tries remaining, the same celebration.
 * That is a much stronger claim than "an indeterminate take does not pass",
 * and it is stated once here rather than once per function.
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
import { NASTY_NUMBERS, chance, intBetween, listOf, makeRng, pickFrom } from "../testing/rng.js";
import type { ActivityAttempt, ActivityProgress } from "../activities/types.js";
import type { PronunciationResult } from "../speech/scoring/types.js";

/** Seeds are literals so every case in this file is reproducible by hand. */
const SEED_HISTORIES = 0x5eed_1a11;
const SEED_R8 = 0x5eed_0008;
const SEED_CELEBRATION = 0x5eed_c313;
const SEED_RAIL = 0x5eed_2a11;

/** How many generated histories each sweep walks. */
const HISTORY_CASES = 2_000;
const CELEBRATION_CASES = 3_000;
const RAIL_CASES = 1_000;

/**
 * A take, built as the real thing rather than a cast.
 *
 * `session.test.ts` uses `{} as never` for the result, which is fine for
 * arithmetic over the `accuracy` field. Here the result is real, because R8 is
 * a claim about the relationship between `result.indeterminate` and
 * `accuracy`: a test that only ever varied `accuracy` could not tell a
 * correctly-null take from a take whose result says one thing and whose
 * accuracy says another.
 */
function take(accuracy: number | null, index = 0): ActivityAttempt {
  const result: PronunciationResult =
    accuracy === null
      ? { indeterminate: true, reason: "NO_SPEECH_DETECTED", provider: "test" }
      : {
          indeterminate: false,
          provider: "test",
          recognized: "bonjour",
          overall: accuracy,
          accuracy,
          fluency: 50,
          completeness: 50,
          words: [],
        };
  return {
    activityId: 1,
    result,
    accuracy,
    // Distinct per take so `at` cannot be the thing that makes two takes
    // compare equal.
    at: new Date(Date.UTC(2026, 8, 7, 10, 0, index)).toISOString(),
  };
}

/**
 * Accuracies a learner could plausibly produce, plus the ones that have
 * actually broken banding and gating arithmetic before.
 *
 * Weighted deliberately: a uniform float over [0, 100] lands on the pass mark
 * essentially never, and the pass mark is where every off-by-one lives.
 */
function generateAccuracy(rng: () => number): number | null {
  if (chance(rng, 0.25)) return null; // an unusable take (R8)
  if (chance(rng, 0.3)) return pickFrom(rng, NASTY_NUMBERS);
  // Clustered around the pass mark, then spread across the full range.
  if (chance(rng, 0.4)) return PASS_SCORE + intBetween(rng, -3, 3);
  return Math.round(rng() * 1000) / 10;
}

/** A generated history of takes for one activity, oldest first. */
function generateHistory(rng: () => number, index: number): ActivityAttempt[] {
  // 0..6 rather than 0..3: the gate has to behave for a history longer than
  // the limit, which is reachable in practice because indeterminate takes do
  // not shorten it.
  const length = intBetween(rng, 0, 6);
  return listOf(length, (i) => take(generateAccuracy(rng), index * 10 + i));
}

/** Folds a history into progress the way the activity screen does. */
function fold(history: ActivityAttempt[]): ActivityProgress[] {
  return history.reduce<ActivityProgress[]>((progress, t) => applyTake(progress, 1, t), []);
}

function entryOf(progress: ActivityProgress[]): ActivityProgress | undefined {
  return progress.find((p) => p.activityId === 1);
}

/** Every scored accuracy in a history, in order. */
function scoredValues(history: ActivityAttempt[]): number[] {
  return history.flatMap((t) => (t.accuracy === null ? [] : [t.accuracy]));
}

describe("the gate, over generated histories", () => {
  const rng = makeRng(SEED_HISTORIES);
  const histories = listOf(HISTORY_CASES, (i) => generateHistory(rng, i));

  it(`sweeps ${HISTORY_CASES} histories that actually reach the interesting shapes`, () => {
    /**
     * A sweep is only worth its machinery if it visits the cases the rules are
     * about. Asserted rather than assumed: a generator change that stopped
     * producing indeterminate takes, or stopped reaching the attempt limit,
     * would leave every other test in this file passing vacuously.
     */
    const withIndeterminate = histories.filter((h) => h.some((t) => t.accuracy === null));
    const atOrPastLimit = histories.filter((h) => scoredValues(h).length >= MAX_ATTEMPTS);
    const passing = histories.filter((h) => scoredValues(h).some((v) => v >= PASS_SCORE));
    const exactlyOneShortOfLimit = histories.filter(
      (h) => scoredValues(h).length === MAX_ATTEMPTS - 1,
    );

    expect(histories).toHaveLength(HISTORY_CASES);
    expect(withIndeterminate.length).toBeGreaterThan(HISTORY_CASES / 4);
    expect(atOrPastLimit.length).toBeGreaterThan(HISTORY_CASES / 10);
    expect(passing.length).toBeGreaterThan(HISTORY_CASES / 4);
    expect(exactlyOneShortOfLimit.length).toBeGreaterThan(HISTORY_CASES / 20);
  });

  it("agrees with itself: the folded best is bestOf the folded attempts", () => {
    histories.forEach((history, i) => {
      const entry = entryOf(fold(history));
      if (history.length === 0) {
        expect(entry, `seed ${SEED_HISTORIES} case ${i}`).toBeUndefined();
        return;
      }
      expect(entry?.best, `seed ${SEED_HISTORIES} case ${i}`).toBe(bestOf(history));
    });
  });

  it("takes the best from the measured takes, and null only when none were", () => {
    histories.forEach((history, i) => {
      const scored = scoredValues(history);
      const best = bestOf(history);
      const where = `seed ${SEED_HISTORIES} case ${i}`;

      if (scored.length === 0) {
        expect(best, where).toBeNull();
        return;
      }
      // Not merely ">= all of them": it must be one of them. A best that is
      // the right size but not a score anyone earned is a fabricated number.
      expect(scored, where).toContain(best);
      for (const value of scored) expect(best, where).toBeGreaterThanOrEqual(value);
    });
  });

  it("counts a try for exactly the takes that produced a number", () => {
    histories.forEach((history, i) => {
      const where = `seed ${SEED_HISTORIES} case ${i}`;
      expect(scoredAttemptsOf(history), where).toBe(scoredValues(history).length);
      expect(scoredAttemptsOf(history), where).toBeLessThanOrEqual(history.length);
    });
  });

  it("derives passed, skipped and advance from the same figures, with no third answer", () => {
    histories.forEach((history, i) => {
      const progress = fold(history);
      const entry = entryOf(progress);
      const where = `seed ${SEED_HISTORIES} case ${i}`;
      if (entry === undefined) {
        expect(canAdvanceFrom(entry), where).toBe(false);
        return;
      }

      const best = bestOf(history);
      const scored = scoredAttemptsOf(history);
      const shouldPass = best !== null && best >= PASS_SCORE;

      expect(entry.passed, where).toBe(shouldPass);
      expect(entry.skipped, where).toBe(!shouldPass && scored >= MAX_ATTEMPTS);
      // Passed and skipped are answers to different questions, but "moved on
      // without passing" and "passed" cannot both be true of one activity.
      expect(entry.passed && entry.skipped, where).toBe(false);
      expect(canAdvanceFrom(entry), where).toBe(shouldPass || scored >= MAX_ATTEMPTS);
    });
  });

  it("never lets a pass or an advance be taken back by a later take", () => {
    histories.forEach((history, i) => {
      let progress: ActivityProgress[] = [];
      let sawPass = false;
      let sawAdvance = false;
      history.forEach((t, step) => {
        progress = applyTake(progress, 1, t);
        const entry = entryOf(progress);
        const where = `seed ${SEED_HISTORIES} case ${i} step ${step}`;
        sawPass = sawPass || entry?.passed === true;
        sawAdvance = sawAdvance || canAdvanceFrom(entry);
        // Monotone: a learner who has earned the right to move on keeps it.
        if (sawPass) expect(entry?.passed, where).toBe(true);
        if (sawAdvance) expect(canAdvanceFrom(entry), where).toBe(true);
      });
    });
  });

  it("counts down the tries one per scored take, never faster", () => {
    histories.forEach((history, i) => {
      let progress: ActivityProgress[] = [];
      let previous = 0;
      history.forEach((t, step) => {
        progress = applyTake(progress, 1, t);
        const scored = scoredAttemptsOf(entryOf(progress)?.attempts ?? []);
        const where = `seed ${SEED_HISTORIES} case ${i} step ${step}`;
        expect(scored - previous, where).toBe(t.accuracy === null ? 0 : 1);
        previous = scored;
      });
    });
  });

  it("treats its inputs as immutable", () => {
    /**
     * The screen holds progress in React state and re-renders from it. A fold
     * that mutated the array or an entry in place would produce a screen that
     * is right until something else re-renders, then silently one take behind
     * — which is indistinguishable from a scoring bug from the outside.
     */
    histories.forEach((history, i) => {
      const where = `seed ${SEED_HISTORIES} case ${i}`;
      const before = fold(history);
      // structuredClone, not a JSON round-trip: `-0` is a generated
      // accuracy and JSON.stringify writes it as `0`, which would make the
      // comparison below fail on the snapshot rather than on the code.
      const snapshot = structuredClone(before);
      const beforeEntry = entryOf(before);
      const after = applyTake(before, 1, take(50, 999));

      expect(before, where).toEqual(snapshot);
      if (beforeEntry !== undefined) {
        expect(after.find((p) => p.activityId === 1), where).not.toBe(beforeEntry);
        expect(beforeEntry.attempts.length, where).toBe(snapshot[0]?.attempts.length);
      }
      expect(after, where).not.toBe(before);
    });
  });

  it("leaves every other activity byte-identical", () => {
    histories.forEach((history, i) => {
      const where = `seed ${SEED_HISTORIES} case ${i}`;
      const others = applySkip(applySkip([], 7), 9);
      const untouched = structuredClone(others);
      const result = history.reduce<ActivityProgress[]>((p, t) => applyTake(p, 1, t), others);
      expect(result.filter((p) => p.activityId !== 1), where).toEqual(untouched);
    });
  });
});

describe("R8 — an unusable take is invisible to the gate", () => {
  const rng = makeRng(SEED_R8);

  /**
   * The strong form of R8, stated once.
   *
   * For every generated history, removing the takes the system declined to
   * judge must change nothing a learner can feel: the same best, the same
   * pass, the same skip, the same tries left, the same right to move on. If
   * any of those differs, an unusable take has silently cost the learner
   * something — which is charging them for our own failure.
   */
  it("is indistinguishable from a history with those takes removed", () => {
    const histories = listOf(HISTORY_CASES, (i) => generateHistory(rng, i));
    const withIndeterminate = histories.filter((h) => h.some((t) => t.accuracy === null));
    // The sweep must actually contain the case it is about.
    expect(withIndeterminate.length).toBeGreaterThan(HISTORY_CASES / 4);

    withIndeterminate.forEach((history, i) => {
      const where = `seed R8 case ${i}`;
      const full = entryOf(fold(history));
      const scoredOnly = entryOf(fold(history.filter((t) => t.accuracy !== null)));

      expect(full?.best ?? null, where).toBe(scoredOnly?.best ?? null);
      expect(full?.passed ?? false, where).toBe(scoredOnly?.passed ?? false);
      expect(full?.skipped ?? false, where).toBe(scoredOnly?.skipped ?? false);
      expect(scoredAttemptsOf(full?.attempts ?? []), where).toBe(
        scoredAttemptsOf(scoredOnly?.attempts ?? []),
      );
      expect(canAdvanceFrom(full), where).toBe(canAdvanceFrom(scoredOnly));
    });
  });

  it("never passes, never celebrates and never burns a try, however many arrive", () => {
    // The pathological session: the microphone is unusable and the learner
    // keeps trying. They must never be told they passed, never be shown
    // confetti, and never be locked out — the tries are all still theirs.
    for (const count of [1, 2, 3, 4, 10, 50]) {
      const history = listOf(count, (i) => take(null, i));
      const entry = entryOf(fold(history));
      const where = `${count} unusable takes`;

      expect(entry?.attempts.length, where).toBe(count);
      expect(entry?.best ?? null, where).toBeNull();
      expect(entry?.passed, where).toBe(false);
      expect(entry?.skipped, where).toBe(false);
      expect(scoredAttemptsOf(entry?.attempts ?? []), where).toBe(0);
      expect(canAdvanceFrom(entry), where).toBe(false);
      for (const t of entry?.attempts ?? []) {
        expect(
          celebrationFor({ accuracy: t.accuracy, previousBest: null, isFirstAttempt: false }),
          where,
        ).toBeNull();
      }
    }
  });

  it("does not bring the limit closer, at any position in the history", () => {
    /**
     * The off-by-one this is really about: two scored takes and one unusable
     * one is three entries in the list, and `attempts.length >= MAX_ATTEMPTS`
     * would end the activity there. Swept across every position the unusable
     * take could occupy, because an implementation that counted the list
     * length would be wrong at all of them and one that mis-indexed would be
     * wrong at exactly one.
     */
    const belowMark = PASS_SCORE - 1;
    for (let position = 0; position <= MAX_ATTEMPTS - 1; position += 1) {
      const history = listOf(MAX_ATTEMPTS - 1, (i) => take(belowMark, i));
      history.splice(position, 0, take(null, 99));
      const entry = entryOf(fold(history));
      const where = `unusable take at position ${position}`;

      expect(entry?.attempts.length, where).toBe(MAX_ATTEMPTS);
      expect(scoredAttemptsOf(entry?.attempts ?? []), where).toBe(MAX_ATTEMPTS - 1);
      expect(canAdvanceFrom(entry), where).toBe(false);
      expect(entry?.skipped, where).toBe(false);
    }
  });
});

describe("the limit itself", () => {
  it("holds at one short of the limit and gives way exactly at it", () => {
    // The off-by-one, walked rather than sampled: for every count of failing
    // scored takes from zero upwards, the learner may move on if and only if
    // they have used the whole allowance.
    const belowMark = PASS_SCORE - 1;
    for (let count = 0; count <= MAX_ATTEMPTS + 3; count += 1) {
      const entry = entryOf(fold(listOf(count, (i) => take(belowMark, i))));
      const where = `${count} failing takes of ${MAX_ATTEMPTS}`;
      expect(canAdvanceFrom(entry), where).toBe(count >= MAX_ATTEMPTS);
      expect(entry?.skipped ?? false, where).toBe(count >= MAX_ATTEMPTS);
    }
  });

  it("passes at the mark and not one step below it", () => {
    // Swept over the representable neighbourhood of the threshold rather than
    // the two integers either side, because accuracy arrives as a float.
    const neighbourhood = [
      PASS_SCORE - 1,
      PASS_SCORE - 0.1,
      PASS_SCORE - Number.EPSILON * PASS_SCORE,
      PASS_SCORE,
      PASS_SCORE + Number.EPSILON * PASS_SCORE,
      PASS_SCORE + 0.1,
      PASS_SCORE + 1,
    ];
    for (const value of neighbourhood) {
      const entry = entryOf(fold([take(value)]));
      expect(entry?.passed, `accuracy ${value}`).toBe(value >= PASS_SCORE);
    }
  });
});

describe("skipping without recording, over generated progress", () => {
  it("is idempotent and never overwrites a history", () => {
    const rng = makeRng(SEED_HISTORIES + 1);
    for (let i = 0; i < 500; i += 1) {
      const history = generateHistory(rng, i);
      const withHistory = fold(history);
      const where = `case ${i}`;

      const once = applySkip(withHistory, 1);
      const twice = applySkip(once, 1);
      expect(twice, where).toBe(once);

      if (history.length > 0) {
        // An activity already attempted keeps its attempts: "could not speak
        // right now" and "tried and did not reach the mark" are different
        // facts and the report tells them apart.
        expect(once, where).toBe(withHistory);
        expect(entryOf(once)?.attempts.length, where).toBe(history.length);
      } else {
        expect(entryOf(once)?.skipped, where).toBe(true);
        expect(entryOf(once)?.attempts, where).toEqual([]);
        expect(entryOf(once)?.best, where).toBeNull();
        expect(entryOf(once)?.passed, where).toBe(false);
      }
    }
  });
});

describe("what to celebrate, swept", () => {
  it(`holds over ${CELEBRATION_CASES} generated verdicts`, () => {
    const rng = makeRng(SEED_CELEBRATION);
    let nulls = 0;
    let firstTries = 0;
    let personalBests = 0;
    let plainPasses = 0;

    for (let i = 0; i < CELEBRATION_CASES; i += 1) {
      const accuracy = generateAccuracy(rng);
      const previousBest = chance(rng, 0.3) ? null : generateAccuracy(rng);
      const isFirstAttempt = chance(rng, 0.5);
      const where = `seed ${SEED_CELEBRATION} case ${i} (${String(accuracy)}, ${String(previousBest)}, ${isFirstAttempt})`;

      const celebration = celebrationFor({ accuracy, previousBest, isFirstAttempt });

      // R8, restated where the motion spec cares about it: confetti over a
      // result the system declined to judge is a fabricated verdict wearing
      // an animation.
      if (accuracy === null) {
        expect(celebration, where).toBeNull();
        nulls += 1;
        continue;
      }
      if (accuracy < PASS_SCORE) {
        expect(celebration, where).toBeNull();
        nulls += 1;
        continue;
      }

      expect(celebration, where).not.toBeNull();
      // The score shown is the score earned — never the best, never a round
      // number, never the previous figure.
      expect(celebration?.score, where).toBe(accuracy);

      if (isFirstAttempt) {
        expect(celebration?.kind, where).toBe("firstTry");
        firstTries += 1;
      } else if (previousBest === null || accuracy > previousBest) {
        expect(celebration?.kind, where).toBe("personalBest");
        personalBests += 1;
      } else {
        expect(celebration?.kind, where).toBe("pass");
        plainPasses += 1;
      }
    }

    // Every branch was actually reached, so none of the above passed by never
    // being asked.
    expect(nulls).toBeGreaterThan(0);
    expect(firstTries).toBeGreaterThan(0);
    expect(personalBests).toBeGreaterThan(0);
    expect(plainPasses).toBeGreaterThan(0);
  });

  it("does not call equalling a previous best a new one", () => {
    // Swept across the whole plausible range rather than at one value: `>=`
    // where `>` belongs is the classic form of this bug and it is wrong
    // everywhere, so the test asks everywhere.
    for (let score = PASS_SCORE; score <= 100; score += 0.5) {
      expect(
        celebrationFor({ accuracy: score, previousBest: score, isFirstAttempt: false })?.kind,
        `equalled ${score}`,
      ).toBe("pass");
      expect(
        celebrationFor({ accuracy: score, previousBest: score - 0.5, isFirstAttempt: false })?.kind,
        `beat ${score - 0.5}`,
      ).toBe("personalBest");
    }
  });

  it("calls a first pass after unusable takes a personal best, not a first try", () => {
    /**
     * `isFirstAttempt` is about the *attempt list*, not about the score. A
     * learner whose first two takes were unusable is on their third attempt
     * and their first measurement — "first try" would be a claim about
     * something that did not happen.
     */
    const history = [take(null, 0), take(null, 1), take(PASS_SCORE + 10, 2)];
    const previousBest = bestOf(history.slice(0, 2));
    expect(previousBest).toBeNull();
    expect(
      celebrationFor({ accuracy: PASS_SCORE + 10, previousBest, isFirstAttempt: false })?.kind,
    ).toBe("personalBest");
  });
});

describe("the progress rail, swept", () => {
  it(`is total and puts current above everything over ${RAIL_CASES} cases`, () => {
    const rng = makeRng(SEED_RAIL);
    const states = new Set<string>();

    for (let i = 0; i < RAIL_CASES; i += 1) {
      const isCurrent = chance(rng, 0.4);
      const shape = intBetween(rng, 0, 3);
      const entry: ActivityProgress | undefined =
        shape === 0
          ? undefined
          : {
              activityId: 1,
              attempts: [],
              best: null,
              // Includes the impossible both-true shape on purpose: this
              // function is fed restored localStorage, which the type system
              // cannot vouch for.
              passed: shape === 1 || shape === 3,
              skipped: shape === 2 || shape === 3,
            };

      const state = stepStateFor(isCurrent, entry);
      states.add(state);
      const where = `seed ${SEED_RAIL} case ${i} (current ${isCurrent}, shape ${shape})`;

      expect(["current", "passed", "skipped", "upcoming"], where).toContain(state);
      if (isCurrent) {
        // Where the learner is wins, even over an activity they already
        // passed and came back to beat.
        expect(state, where).toBe("current");
      } else if (entry?.passed === true) {
        expect(state, where).toBe("passed");
      } else if (entry?.skipped === true) {
        expect(state, where).toBe("skipped");
      } else {
        expect(state, where).toBe("upcoming");
      }
    }

    // All four states reachable — otherwise the sweep proves nothing about
    // the ones it never produced.
    expect([...states].sort()).toEqual(["current", "passed", "skipped", "upcoming"]);
  });
});
