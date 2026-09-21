/**
 * The syllabus mapping, held to the same standard as the difficulty table.
 *
 * Completeness is machine-checkable and correctness is not, so this asserts
 * the first exhaustively and says plainly that it cannot do the second. The
 * failure it exists to prevent is the one a coverage claim always has: a
 * course that says it covers A1 while three of its activities are mapped to
 * nothing, which nobody notices because the page still renders a level.
 */

import { describe, expect, it } from "vitest";
import { cefrFor, cefrMapFor, levelsCovered } from "./cefr.js";
import { LANGUAGES } from "./languages/index.js";
import { COURSES } from "./courses/index.js";

const shipped = [...LANGUAGES, ...COURSES];

/** Every (language, activity) pair the product ships — the real unit of coverage. */
const everyPair = shipped.flatMap((set) => set.activities.map((a) => ({ slug: set.slug, id: a.id })));

describe("coverage", () => {
  it("maps every activity the product ships, in every language", () => {
    for (const { slug, id } of everyPair) {
      expect(cefrFor(slug, id), `${slug} activity ${String(id)} is covered by nothing`).not.toBeNull();
    }
  });

  /**
   * And nothing it does not ship. An entry for an id that no longer exists is
   * a claim about content that is gone — it would keep a level on the page
   * after the activity backing it was deleted.
   */
  it("maps nothing that does not exist", () => {
    for (const set of shipped) {
      const real = new Set(set.activities.map((a) => a.id));
      for (const entry of cefrMapFor(set.slug)) {
        for (const id of entry.ids) {
          // The bundled sets legitimately lack the course additions, so this
          // only refuses a claim no *course* for that language backs either.
          const anywhere = shipped.some(
            (other) => other.slug === set.slug && other.activities.some((a) => a.id === id),
          );
          expect(
            real.has(id) || anywhere,
            `${set.slug} claims activity ${String(id)}, which nothing in ${set.slug} ships`,
          ).toBe(true);
        }
      }
    }
  });

  it("covers each activity exactly once per language", () => {
    for (const slug of new Set(shipped.map((set) => set.slug))) {
      const seen = new Map<number, string>();
      for (const entry of cefrMapFor(slug)) {
        for (const id of entry.ids) {
          expect(seen.get(id), `${slug} activity ${String(id)} is claimed twice`).toBeUndefined();
          seen.set(id, entry.canDo);
        }
      }
    }
  });

  /** Non-vacuity: every check above passes happily against an empty product. */
  it("is reading real content", () => {
    expect(everyPair.length).toBeGreaterThan(40);
    expect(cefrMapFor("fr").length).toBeGreaterThan(5);
  });
});

/**
 * What the map used to assume, kept as a test of the thing that is actually
 * true.
 *
 * The first version keyed by activity id alone, on the premise that the
 * content is parallel across languages. It is — for the bundled ten, and not
 * past them. This test found Spanish 11 to 18 is different content entirely
 * where French and German run in step, so "activity 11" means one thing in one
 * course and another in the next.
 *
 * The premise is now scoped to the ten that hold it, and asserted there.
 */
describe("the shared ten really are shared", () => {
  it("asks the same thing of a learner in every language, for activities 1 to 10", () => {
    const byId = new Map<number, { kind: string; where: string }>();

    for (const set of shipped) {
      for (const activity of set.activities) {
        if (activity.id > 10) continue;
        const first = byId.get(activity.id);
        if (first === undefined) {
          byId.set(activity.id, { kind: activity.kind, where: set.slug });
          continue;
        }
        expect(
          activity.kind,
          `activity ${String(activity.id)} is a ${first.kind} in ${first.where} and a ${activity.kind} in ${set.slug}`,
        ).toBe(first.kind);
      }
    }
  });

  /**
   * And past ten they are allowed to differ — asserted, so that if the courses
   * ever do converge somebody notices and collapses the map rather than
   * maintaining three copies of one list.
   */
  it("lets the courses diverge past the shared ten, as they do today", () => {
    const es = shipped.find((set) => set.slug === "es" && set.activities.length > 10);
    const fr = shipped.find((set) => set.slug === "fr" && set.activities.length > 10);

    expect(es).toBeDefined();
    expect(fr).toBeDefined();
    const esGloss = es?.activities.find((a) => a.id === 11)?.gloss;
    const frGloss = fr?.activities.find((a) => a.id === 11)?.gloss;

    expect(esGloss).toBeDefined();
    expect(frGloss).toBeDefined();
    expect(esGloss).not.toBe(frGloss);
  });
});

describe("what each entry says", () => {
  it("is phrased as something a learner can do", () => {
    for (const slug of ["fr", "es", "de"]) {
      for (const entry of cefrMapFor(slug)) {
        expect(entry.canDo, JSON.stringify(entry.ids)).toMatch(/^Can /);
        expect(entry.canDo.endsWith("."), entry.canDo).toBe(true);
      }
    }
  });

  /**
   * No level above A2 anywhere. The content is functional beginner material
   * and saying so is the honest claim — a B1 on a syllabus sheet this content
   * cannot support is the kind of overstatement that loses a school on the
   * first lesson rather than at the sale.
   */
  it("claims nothing above A2", () => {
    for (const slug of ["fr", "es", "de"]) {
      for (const entry of cefrMapFor(slug)) {
        expect(["A1", "A2"]).toContain(entry.level);
      }
    }
  });

  /**
   * Perception is separated from production, because the framework separates
   * them: hearing a sound in a phrase is not being able to say it.
   */
  it("separates listening from speaking", () => {
    const listening = cefrMapFor("fr").filter((entry) => entry.skill === "listening");

    expect(listening.length).toBeGreaterThan(0);
    for (const entry of listening) {
      expect(entry.canDo).toMatch(/recognise|hear|listen/i);
    }
  });
});

describe("reporting what a course reaches", () => {
  it("returns the levels present, lowest first", () => {
    expect(levelsCovered("fr", [1, 9])).toEqual(["A1", "A2"]);
    expect(levelsCovered("fr", [1, 2])).toEqual(["A1"]);
    expect(levelsCovered("fr", [9])).toEqual(["A2"]);
  });

  it("says nothing for activities it does not know", () => {
    expect(levelsCovered("fr", [9999])).toEqual([]);
    expect(levelsCovered("fr", [])).toEqual([]);
    expect(levelsCovered("nonexistent", [1])).toEqual(["A1"]);
  });

  /**
   * The bundled French set reaches A2 — which is a fact about content and not
   * about any learner. Pinned because it is the number that would appear on a
   * syllabus sheet.
   */
  it("reports what the shipped French course actually covers", () => {
    const french = COURSES.find((c) => c.slug === "fr");
    expect(french).toBeDefined();

    expect(levelsCovered("fr", french?.activities.map((a) => a.id) ?? [])).toEqual(["A1", "A2"]);
  });
});
