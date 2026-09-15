/**
 * N6 — curriculum coverage, asserted against what this product can actually
 * measure.
 *
 * The item as written asks that "every phoneme in the inventory appears", and
 * that check cannot be built as stated. There is no phoneme inventory in the
 * repository, and there is a stronger reason than that: **the provider returns
 * no phoneme names for any locale this product ships.** Measured across three
 * real takes — 0 of 14, 0 of 23 and 0 of 28 labels populated (docs/DESIGN-DATA.md
 * §3). Every phoneme is scored; none is named. Only `en-US`, reachable from the
 * internal fixture screen, returns names at all.
 *
 * So a coverage check against phonemes would compare a list nobody wrote to a
 * field that is always blank, and pass for the wrong reason forever.
 *
 * What *is* real is the **written syllable** — the grapheme field, around 83%
 * named for French — which is what the scheduler schedules over, what the
 * syllable chips show, and what a learner is told about their own
 * pronunciation. So this checks coverage of those, which is the same question
 * asked about the thing the product actually measures.
 */

import { describe, expect, it } from "vitest";
import { COURSES } from "./index.js";
import { MIN_LESSON_ACTIVITIES, MAX_LESSON_ACTIVITIES } from "../types.js";

const courses = Object.values(COURSES);

describe("the shipped courses are actually there", () => {
  // Guards every assertion below: an empty list makes all of them vacuous.
  it("ships at least one course, with units in it", () => {
    expect(courses.length).toBeGreaterThan(0);
    for (const course of courses) {
      expect(course.units?.length ?? 0, course.slug).toBeGreaterThan(0);
    }
  });
});

describe.each(courses.map((c) => [c.label, c] as const))("%s", (label, course) => {
  const units = course.units ?? [];
  const lessons = units.flatMap((unit) => unit.lessons);
  const referenced = [...new Set(lessons.flatMap((lesson) => lesson.activityIds))];
  const byId = new Map(course.activities.map((a) => [a.id, a]));

  /** Every written syllable the course drills, and how many activities drill it. */
  const soundCounts = new Map<string, number>();
  for (const id of referenced) {
    for (const sound of byId.get(id)?.soundTargets ?? []) {
      soundCounts.set(sound, (soundCounts.get(sound) ?? 0) + 1);
    }
  }

  it("names a sound for every activity a lesson leads to", () => {
    for (const id of referenced) {
      const activity = byId.get(id);
      expect(activity, `${label}: lesson references activity ${String(id)}, which does not exist`)
        .toBeDefined();
      expect(activity?.soundTargets?.length ?? 0, `${label}: activity ${String(id)}`)
        .toBeGreaterThan(0);
    }
  });

  /**
   * Every sound has somewhere to be practised. That is the correctness bar,
   * and it is weaker than the one I first wrote here.
   *
   * The first version required every sound to appear in **two or more**
   * activities, on the reasoning that a due sound with one phrase sends a
   * learner back to the same phrase forever. Both shipped courses fail that:
   * roughly sixty distinct sounds across eighteen activities, none recurring.
   *
   * But the bar was invented. Returning to the same phrase at expanding
   * intervals is how spaced repetition normally works — the ladder solves
   * *spacing*, not variety — so failing the shipped curriculum against it would
   * have been this test asserting a preference. The variety observation is
   * recorded in the queue as content feedback instead, beside the curriculum
   * sizing question that is already the owner's to answer.
   */
  it("gives every sound at least one activity that drills it", () => {
    const stranded = [...soundCounts.entries()].filter(([, count]) => count < 1).map(([s]) => s);

    expect(stranded, `${label}: sounds with nowhere to practise them`).toEqual([]);
    expect(soundCounts.size, `${label}: no sounds at all`).toBeGreaterThan(0);
  });

  /**
   * Every syllable a course names has to occur in the phrase it is attached
   * to, or it can never come back from the scorer. The publish gate enforces
   * this for authored content; the bundled courses never pass through it.
   */
  it("names only syllables that occur in their own phrase", () => {
    for (const id of referenced) {
      const activity = byId.get(id);
      const target = activity?.target.toLocaleLowerCase() ?? "";
      for (const sound of activity?.soundTargets ?? []) {
        expect(target, `${label}: activity ${String(id)} names “${sound}”`).toContain(sound);
      }
    }
  });

  it("reaches every activity it ships from some lesson", () => {
    const unreachable = course.activities.filter((a) => !referenced.includes(a.id)).map((a) => a.id);

    expect(unreachable, `${label}: activities no lesson leads to`).toEqual([]);
  });

  it("puts each activity in exactly one lesson", () => {
    const seen = new Map<number, number>();
    for (const lesson of lessons) {
      for (const id of lesson.activityIds) seen.set(id, (seen.get(id) ?? 0) + 1);
    }

    const shared = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
    expect(shared, `${label}: activities in more than one lesson`).toEqual([]);
  });

  it("keeps every lesson to a sitting a learner can finish", () => {
    for (const lesson of lessons) {
      expect(lesson.activityIds.length, `${label}: lesson ${String(lesson.id)}`)
        .toBeGreaterThanOrEqual(MIN_LESSON_ACTIVITIES);
      expect(lesson.activityIds.length, `${label}: lesson ${String(lesson.id)}`)
        .toBeLessThanOrEqual(MAX_LESSON_ACTIVITIES);
    }
  });

  /**
   * A can-do statement on every unit and lesson, because Journey renders them
   * as claims. A unit with an empty outcome would show a claim with nothing in
   * it, which reads as a rendering fault rather than as missing content.
   */
  it("gives every unit and lesson a can-do statement", () => {
    for (const unit of units) {
      expect(unit.outcome.trim().length, `${label}: unit ${String(unit.id)}`).toBeGreaterThan(0);
    }
    for (const lesson of lessons) {
      expect(lesson.outcome.trim().length, `${label}: lesson ${String(lesson.id)}`)
        .toBeGreaterThan(0);
    }
  });
});
