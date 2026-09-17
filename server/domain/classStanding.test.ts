/**
 * The one-way door an accuracy goes through before a teacher can see anything.
 *
 * Two properties carry the weight. A pupil who has never attempted a sound
 * must not be counted as one who is struggling with it, and the thresholds
 * here must be the scheduler's own — a class that looked like it was holding a
 * sound the scheduler still considered due would send a teacher past a lesson
 * the product is still asking for.
 */

import { describe, expect, it } from "vitest";
import { STRONG, WEAK } from "./scheduler.js";
import { standingOf, standingsFor, takesFor } from "./classStanding.js";
import type { Skill } from "./merge.js";

function skill(grapheme: string, accuracies: number[]): Skill {
  return {
    grapheme,
    samples: accuracies.map((accuracy, i) => ({
      at: `2026-09-${String(i + 1).padStart(2, "0")}T09:00:00.000Z`,
      accuracy,
    })),
  };
}

describe("one sound", () => {
  /**
   * The distinction the class summary depends on. `strengthOf` returns 0 for
   * an empty sample list and warns that callers must not read that as "said
   * badly" — reading it that way here would count everyone who has not reached
   * a sound as struggling with it, and inflate the figure a lesson is planned
   * from by the whole rest of the class.
   */
  it("says nothing about a sound the pupil has never attempted", () => {
    expect(standingOf(skill("ʁ", []))).toBeNull();
  });

  it("holds a sound said consistently well", () => {
    expect(standingOf(skill("ʁ", [88, 91, 90]))).toBe("holding");
  });

  it("is getting there between the two thresholds", () => {
    expect(standingOf(skill("ʁ", [70, 72, 71]))).toBe("getting-there");
  });

  it("has just started below the weak threshold", () => {
    expect(standingOf(skill("ʁ", [40, 45, 42]))).toBe("just-started");
  });

  /**
   * The boundaries are the scheduler's, and read the same way it reads them:
   * `>= STRONG` is strong, `< WEAK` is weak. A sound sitting exactly on a
   * threshold must not land in a different bucket here than it does there.
   */
  it("treats each threshold the way the scheduler does", () => {
    expect(standingOf(skill("a", [STRONG]))).toBe("holding");
    expect(standingOf(skill("a", [STRONG - 1]))).toBe("getting-there");
    expect(standingOf(skill("a", [WEAK]))).toBe("getting-there");
    expect(standingOf(skill("a", [WEAK - 1]))).toBe("just-started");
  });

  /**
   * `strengthOf` weights recent takes three times the oldest, so a sound fixed
   * last week reads as fixed. The standing inherits that rather than averaging
   * flatly — otherwise a pupil who has genuinely got there keeps being counted
   * against their teacher's lesson plan.
   */
  it("follows the scheduler in weighting recent takes more heavily", () => {
    // Same five numbers, opposite order. Chosen so the weighted means land in
    // different buckets — an earlier pair differed by fourteen points and
    // still fell either side of nothing, so the assertion held with any
    // weighting at all, including none.
    const improving = standingOf(skill("ʁ", [60, 70, 85, 95, 99]));
    const declining = standingOf(skill("ʁ", [99, 95, 85, 70, 60]));

    expect(improving).toBe("holding");
    expect(declining).toBe("getting-there");
  });
});

describe("a pupil's whole record", () => {
  it("keys every sound they have reached, and omits the rest", () => {
    const standings = standingsFor([skill("ʁ", [40]), skill("u", [90]), skill("an", [])]);

    expect(standings).toEqual({ "ʁ": "just-started", u: "holding" });
    expect("an" in standings).toBe(false);
  });

  it("counts takes per sound, and omits a sound with none", () => {
    expect(takesFor([skill("ʁ", [40, 50, 60]), skill("an", [])])).toEqual({ "ʁ": 3 });
  });

  /**
   * A take count is a volume, not a verdict — the same kind of fact as "the
   * days you practised", which the promise already shares. It must not vary
   * with how well the takes went.
   */
  it("counts takes without regard to how they scored", () => {
    expect(takesFor([skill("ʁ", [10, 20, 30])])).toEqual(
      takesFor([skill("ʁ", [90, 95, 99])]),
    );
  });
});
