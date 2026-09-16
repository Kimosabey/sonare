/**
 * The promise a class makes to a pupil, held to being one promise.
 *
 * Boards 1c and 1h. Two properties, and both are about the difference between
 * a policy and a design:
 *
 *  - **One list, two screens.** The pupil is shown "the same one the teacher
 *    was shown, so neither side is told a different story". Two hand-written
 *    lists agree on the day they are written and drift at the first change,
 *    invisibly, because nobody reads both screens at once.
 *  - **The withheld things are not switches.** Scores, recordings and rankings
 *    are absent from what a class view is *given*. A test on the screen would
 *    only prove the screen does not render them today; a test on the shape
 *    proves there is nothing to render.
 *
 * Written before any teacher feature exists, which is when a constraint is
 * cheap. `forbiddenPathsIn` is the check the class view will have to pass.
 */

import { describe, expect, it } from "vitest";
import {
  CLASS_CAPABILITIES,
  FORBIDDEN_IN_CLASS_VIEW,
  NEVER_SHARED_WITH_CLASS,
  SHARED_WITH_CLASS,
  forbiddenPathsIn,
} from "./promise.js";

describe("the list itself", () => {
  it("says what is shared and what never is, with a reason for each", () => {
    expect(SHARED_WITH_CLASS.length).toBeGreaterThan(0);
    expect(NEVER_SHARED_WITH_CLASS.length).toBeGreaterThan(0);

    for (const fact of [...SHARED_WITH_CLASS, ...NEVER_SHARED_WITH_CLASS]) {
      expect(fact.label.trim().length, fact.label).toBeGreaterThan(0);
      // The reason is the part a pupil can disagree with, so it has to be there.
      expect(fact.because.trim().length, fact.label).toBeGreaterThan(0);
    }
  });

  /**
   * Nothing may be on both lists. It reads as a contradiction to a pupil and
   * it would mean the two screens disagree with each other while rendering the
   * same source.
   */
  it("never puts the same thing on both lists", () => {
    const shared = new Set(SHARED_WITH_CLASS.map((f) => f.label.toLowerCase()));
    for (const fact of NEVER_SHARED_WITH_CLASS) {
      expect(shared.has(fact.label.toLowerCase()), fact.label).toBe(false);
    }
  });

  /**
   * Everything shared is about *whether* a pupil practised, never about how
   * well. That is the line the whole design rests on, and the words that would
   * cross it are worth naming.
   */
  it("shares nothing that is a judgement about how well somebody spoke", () => {
    for (const fact of SHARED_WITH_CLASS) {
      expect(fact.label.toLowerCase(), fact.label).not.toMatch(
        /score|accuracy|rank|best|compare|recording/,
      );
    }
  });
});

describe("what a teacher can ask for", () => {
  it("answers every request, allowed or not", () => {
    expect(CLASS_CAPABILITIES.length).toBeGreaterThan(0);

    for (const capability of CLASS_CAPABILITIES) {
      expect(capability.request.trim().length).toBeGreaterThan(0);
      expect(capability.answer.trim().length, capability.request).toBeGreaterThan(0);
      // A refusal has to say why, or it reads as a feature nobody built yet.
      if (!capability.allowed) {
        expect(capability.answer.toLowerCase(), capability.request).toContain("no");
      }
    }
  });

  /**
   * The three the board names as not-switches must actually be refused here.
   * If one of them ever flips to `allowed`, that is a product decision being
   * made in a data file, and it should be loud.
   */
  it("refuses scores, recordings and ranking", () => {
    for (const wanted of [/pronunciation score/i, /recording/i, /rank or sort/i]) {
      const capability = CLASS_CAPABILITIES.find((c) => wanted.test(c.request));
      expect(capability, String(wanted)).toBeDefined();
      expect(capability?.allowed, capability?.request).toBe(false);
    }
  });

  /** Both sides of the list are populated, or the panel is an assertion. */
  it("is not a list of refusals wearing a heading", () => {
    expect(CLASS_CAPABILITIES.some((c) => c.allowed)).toBe(true);
    expect(CLASS_CAPABILITIES.some((c) => !c.allowed)).toBe(true);
  });
});

describe("the shape a class view may receive", () => {
  /** What a class view would plausibly carry: attendance and coverage, named. */
  const acceptable = {
    className: "Year 9 French",
    pupils: [
      { firstName: "Maya", daysPractised: 12, lessonsDone: 5 },
      { firstName: null, daysPractised: 3, lessonsDone: 1 },
    ],
    sounds: [{ grapheme: "jour", pupilsFindingItHard: 7 }],
  };

  it("passes a payload made only of attendance and coverage", () => {
    expect(forbiddenPathsIn(acceptable)).toEqual([]);
  });

  /**
   * The check that matters, and it is deliberately about the *shape* rather
   * than the screen. A screen that does not render a field it was handed is
   * one refactor from rendering it.
   */
  it("names a forbidden field wherever it is buried", () => {
    const leaked = {
      ...acceptable,
      pupils: [{ firstName: "Maya", daysPractised: 12, bestAccuracy: 88 }],
    };

    expect(forbiddenPathsIn(leaked)).toEqual(["pupils[0].bestAccuracy"]);
  });

  it("finds one several levels down, where a careless spread would put it", () => {
    const leaked = { term: { week: { pupil: { attempts: [{ accuracy: 91 }] } } } };

    expect(forbiddenPathsIn(leaked)).toContain("term.week.pupil.attempts");
  });

  it("finds every one rather than stopping at the first", () => {
    const leaked = {
      pupils: [
        { firstName: "A", score: 70 },
        { firstName: "B", rank: 2 },
      ],
    };

    expect(forbiddenPathsIn(leaked).sort()).toEqual(["pupils[0].score", "pupils[1].rank"]);
  });

  /**
   * The names are the ones the rest of the codebase actually uses. A forbidden
   * list of invented words would pass every test here and catch nothing real.
   */
  it("forbids the field names this codebase actually stores scores under", () => {
    for (const real of ["accuracy", "best", "bestAccuracy", "attempts", "wav", "strength"]) {
      expect(FORBIDDEN_IN_CLASS_VIEW, real).toContain(real);
    }
  });

  it("is untroubled by nulls, primitives and empty structures", () => {
    for (const value of [null, undefined, 3, "x", true, [], {}]) {
      expect(forbiddenPathsIn(value)).toEqual([]);
    }
  });
});
