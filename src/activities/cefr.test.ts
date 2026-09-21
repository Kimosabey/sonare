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
import { CEFR_MAP, cefrFor, levelsCovered } from "./cefr.js";
import { LANGUAGES } from "./languages/index.js";
import { COURSES } from "./courses/index.js";

const shipped = [...LANGUAGES, ...COURSES];
const everyId = [...new Set(shipped.flatMap((set) => set.activities.map((a) => a.id)))].sort(
  (a, b) => a - b,
);

describe("coverage", () => {
  it("maps every activity the product ships", () => {
    for (const id of everyId) {
      expect(cefrFor(id), `activity ${String(id)} is covered by nothing`).not.toBeNull();
    }
  });

  /**
   * And nothing it does not ship. An entry for an id that no longer exists is
   * a claim about content that is gone — it would keep a level on the page
   * after the activity backing it was deleted.
   */
  it("maps nothing that does not exist", () => {
    const real = new Set(everyId);

    for (const entry of CEFR_MAP) {
      for (const id of entry.ids) {
        expect(real.has(id), `entry claims activity ${String(id)}, which nothing ships`).toBe(true);
      }
    }
  });

  it("covers each activity exactly once", () => {
    const seen = new Map<number, string>();

    for (const entry of CEFR_MAP) {
      for (const id of entry.ids) {
        expect(seen.get(id), `activity ${String(id)} is claimed twice`).toBeUndefined();
        seen.set(id, entry.canDo);
      }
    }
  });

  /** Non-vacuity: every check above passes happily against an empty product. */
  it("is reading real content", () => {
    expect(everyId.length).toBeGreaterThan(15);
    expect(CEFR_MAP.length).toBeGreaterThan(5);
  });
});

describe("the assumption the map is built on", () => {
  /**
   * One entry describes the same function in every language, which is only
   * honest while the content stays parallel — activity 3 ordering a drink in
   * French, Spanish and German alike.
   *
   * The day a language diverges, this fails and the map has to grow a
   * per-language shape.
   *
   * Asserted through `kind`, not through the English gloss. The first version
   * compared glosses and failed correctly on content that is right: activity 2
   * is "I live in Paris" in French and "I live in Madrid" in Spanish, because a
   * Spanish course saying Paris would be worse content. The particulars are
   * localised on purpose; the *function* is what repeats, and a shared `kind`
   * per id is the part of that a machine can see.
   *
   * The functional parallel itself — that activity 3 is ordering a drink in
   * every language — stays authored and unchecked, like the levels it feeds.
   */
  it("keeps the same activity id asking the same thing of a learner", () => {
    const byId = new Map<number, { kind: string; where: string }>();

    for (const set of shipped) {
      for (const activity of set.activities) {
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
});

describe("what each entry says", () => {
  it("is phrased as something a learner can do", () => {
    for (const entry of CEFR_MAP) {
      expect(entry.canDo, JSON.stringify(entry.ids)).toMatch(/^Can /);
      expect(entry.canDo.endsWith("."), entry.canDo).toBe(true);
    }
  });

  /**
   * No level above A2 anywhere. The content is functional beginner material
   * and saying so is the honest claim — a B1 on a syllabus sheet this content
   * cannot support is the kind of overstatement that loses a school on the
   * first lesson rather than at the sale.
   */
  it("claims nothing above A2", () => {
    for (const entry of CEFR_MAP) {
      expect(["A1", "A2"]).toContain(entry.level);
    }
  });

  /**
   * Perception is separated from production, because the framework separates
   * them: hearing a sound in a phrase is not being able to say it.
   */
  it("separates listening from speaking", () => {
    const listening = CEFR_MAP.filter((entry) => entry.skill === "listening");

    expect(listening.length).toBeGreaterThan(0);
    for (const entry of listening) {
      expect(entry.canDo).toMatch(/recognise|hear|listen/i);
    }
  });
});

describe("reporting what a course reaches", () => {
  it("returns the levels present, lowest first", () => {
    expect(levelsCovered([1, 9])).toEqual(["A1", "A2"]);
    expect(levelsCovered([1, 2])).toEqual(["A1"]);
    expect(levelsCovered([9])).toEqual(["A2"]);
  });

  it("says nothing for activities it does not know", () => {
    expect(levelsCovered([9999])).toEqual([]);
    expect(levelsCovered([])).toEqual([]);
  });

  /**
   * The bundled French set reaches A2 — which is a fact about content and not
   * about any learner. Pinned because it is the number that would appear on a
   * syllabus sheet.
   */
  it("reports what the shipped French course actually covers", () => {
    const french = COURSES.find((c) => c.slug === "fr");
    expect(french).toBeDefined();

    expect(levelsCovered(french?.activities.map((a) => a.id) ?? [])).toEqual(["A1", "A2"]);
  });
});
