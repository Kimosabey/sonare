/**
 * The class boundary, tested as a boundary rather than as a function.
 *
 * Most of these do not check that a number is right. They check that a number
 * is **absent** — that nothing identifying a pupil, and no figure about how
 * one of them spoke, can be reached from what a class view is handed. That is
 * the Teacher board's one hard rule, and the reason it is drawn here instead
 * of at a screen: a view that merely declines to render a figure is one API
 * response away from leaking it.
 */

import { describe, expect, it } from "vitest";
import { MIN_REPORTABLE_CLASS, summariseClass, type PupilPractice } from "./classSummary.js";
import { forbiddenPathsIn } from "./promise.js";

function pupil(id: string, over: Partial<PupilPractice> = {}): PupilPractice {
  return {
    pupilId: id,
    strugglingWith: [],
    secureWith: [],
    days: [],
    ...over,
  };
}

/** A class large enough to report on, so the floor is not what is under test. */
function classOf(size: number, over: (i: number) => Partial<PupilPractice> = () => ({})) {
  return Array.from({ length: size }, (_, i) => pupil(`p${i}`, over(i)));
}

describe("nothing identifying survives", () => {
  /**
   * The property the whole file exists for, swept rather than sampled. No
   * pupil id may be reachable from the summary by any path — not as a key,
   * not in an array, not nested.
   */
  it("carries no pupil identifier anywhere in the result", () => {
    const pupils = classOf(12, (i) => ({
      strugglingWith: ["ʁ", "u"].slice(0, (i % 2) + 1),
      secureWith: ["a"],
      days: ["2026-09-01", "2026-09-02"].slice(0, (i % 2) + 1),
    }));

    const summary = summariseClass(pupils);
    const serialised = JSON.stringify(summary);

    for (const p of pupils) {
      expect(serialised, `${p.pupilId} reachable in the summary`).not.toContain(p.pupilId);
    }
  });

  /**
   * The same check the pupil-facing promise is held to. `FORBIDDEN_IN_CLASS_VIEW`
   * names every field that is or could become a figure about a named child, and
   * this fails the moment one appears in the shape a class view receives —
   * long before any screen renders it.
   */
  it("carries no forbidden field, by the same list the promise is built from", () => {
    const summary = summariseClass(
      classOf(9, () => ({ strugglingWith: ["ʁ"], secureWith: ["a"], days: ["2026-09-01"] })),
    );

    expect(forbiddenPathsIn(summary)).toEqual([]);
  });

  it("carries no forbidden field when the class is too small to report", () => {
    expect(forbiddenPathsIn(summariseClass([pupil("a"), pupil("b")]))).toEqual([]);
  });
});

describe("the small-class floor", () => {
  /**
   * The board says a count "cannot be turned back into anybody's number". That
   * holds for the 28-pupil class it draws and fails for a small one: "2 of 2
   * still working on ʁ", shown to a teacher who knows which two joined, is a
   * statement about both of them by name.
   */
  it("withholds counts below the floor, and says why", () => {
    const summary = summariseClass(
      classOf(MIN_REPORTABLE_CLASS - 1, () => ({ strugglingWith: ["ʁ"] })),
    );

    expect(summary.reportable).toBe(false);
    if (summary.reportable) throw new Error("expected a withheld summary");
    expect(summary.reason).toBe("class-too-small");
    expect(summary.joinedCount).toBe(MIN_REPORTABLE_CLASS - 1);
  });

  it("reports at the floor exactly", () => {
    const summary = summariseClass(
      classOf(MIN_REPORTABLE_CLASS, () => ({ strugglingWith: ["ʁ"] })),
    );

    expect(summary.reportable).toBe(true);
  });

  /**
   * The withheld shape carries no sounds and no attendance at all, rather than
   * empty arrays. A view handed `sounds: []` would render an empty table, and
   * a teacher reads an empty difficulty table as "nobody is struggling".
   */
  it("withholds the figures themselves, not merely a flag", () => {
    const summary = summariseClass([pupil("a", { strugglingWith: ["ʁ"], days: ["2026-09-01"] })]);

    expect(JSON.stringify(summary)).not.toContain("ʁ");
    expect(JSON.stringify(summary)).not.toContain("2026-09-01");
  });

  /**
   * Two records for one pupil must not inflate the class past the floor —
   * larger is the direction that wrongly unlocks reporting.
   */
  it("counts distinct pupils, so duplicates cannot unlock reporting", () => {
    const duplicated = Array.from({ length: MIN_REPORTABLE_CLASS + 3 }, () =>
      pupil("the-same-pupil", { strugglingWith: ["ʁ"] }),
    );

    expect(summariseClass(duplicated).reportable).toBe(false);
  });
});

describe("sound difficulty", () => {
  it("counts pupils working on a sound, never an average", () => {
    const summary = summariseClass([
      ...classOf(3, () => ({ strugglingWith: ["ʁ"] })),
      ...classOf(4, () => ({ secureWith: ["ʁ"] })).map((p, i) => ({ ...p, pupilId: `s${i}` })),
    ]);

    if (!summary.reportable) throw new Error("expected a reportable summary");
    const r = summary.sounds.find((s) => s.grapheme === "ʁ");
    expect(r?.working).toBe(3);
    expect(r?.secure).toBe(4);
  });

  /**
   * The board: "Rows are ordered by that count and the order is fixed; there
   * is no sort control, because the only other thing to sort by does not exist
   * here."
   */
  it("orders by how many are working on it, hardest first", () => {
    const summary = summariseClass([
      ...classOf(6, (i) => ({ strugglingWith: i < 5 ? ["ʁ", "u"] : ["u"] })),
    ]);

    if (!summary.reportable) throw new Error("expected a reportable summary");
    expect(summary.sounds.map((s) => s.grapheme)).toEqual(["u", "ʁ"]);
  });

  /**
   * The pupils here list their sounds in **different orders**, which is what
   * makes this bite. An earlier version gave every pupil the same list, so the
   * insertion order of the internal map was identical however the roll was
   * shuffled and the test passed with no tiebreak at all.
   */
  it("breaks a tie by grapheme, so the order is stable across calls", () => {
    const pupils = [
      pupil("a", { strugglingWith: ["u", "ʁ", "e"] }),
      pupil("b", { strugglingWith: ["e", "u", "ʁ"] }),
      pupil("c", { strugglingWith: ["ʁ", "e", "u"] }),
      pupil("d", { strugglingWith: ["ʁ", "u", "e"] }),
      pupil("e", { strugglingWith: ["e", "ʁ", "u"] }),
      pupil("f", { strugglingWith: ["u", "e", "ʁ"] }),
    ];

    const first = summariseClass(pupils);
    const second = summariseClass([...pupils].reverse());

    if (!first.reportable || !second.reportable) throw new Error("expected reportable summaries");
    // All three are tied at six, so only the tiebreak decides the order.
    expect(first.sounds.map((s) => s.grapheme)).toEqual(["e", "u", "ʁ"]);
    expect(second.sounds.map((s) => s.grapheme)).toEqual(first.sounds.map((s) => s.grapheme));
  });

  /**
   * Counted once per pupil however many times they appear. Otherwise a pupil
   * who synced twice would make a sound look harder for the class than it is,
   * and the board's whole point is that this number drives the next lesson.
   */
  it("counts a pupil once per sound, however many records they have", () => {
    const summary = summariseClass([
      ...classOf(5),
      pupil("dup", { strugglingWith: ["ʁ"] }),
      pupil("dup", { strugglingWith: ["ʁ"] }),
    ]);

    if (!summary.reportable) throw new Error("expected a reportable summary");
    expect(summary.sounds.find((s) => s.grapheme === "ʁ")?.working).toBe(1);
  });

  /**
   * Contradictory input resolves towards "working". A pupil listed as both is
   * a data problem, and the reading that tells a teacher the class is fine
   * when it is not is the one that costs a lesson.
   */
  it("does not count a pupil as secure on a sound they are working on", () => {
    const summary = summariseClass([
      ...classOf(5),
      pupil("both", { strugglingWith: ["ʁ"], secureWith: ["ʁ"] }),
    ]);

    if (!summary.reportable) throw new Error("expected a reportable summary");
    const r = summary.sounds.find((s) => s.grapheme === "ʁ");
    expect(r?.working).toBe(1);
    expect(r?.secure).toBe(0);
  });

  it("accounts for pupils who have not reached a sound at all", () => {
    const summary = summariseClass([
      ...classOf(5),
      pupil("x", { strugglingWith: ["ʁ"] }),
      pupil("y", { secureWith: ["ʁ"] }),
    ]);

    if (!summary.reportable) throw new Error("expected a reportable summary");
    const r = summary.sounds.find((s) => s.grapheme === "ʁ");
    expect(r?.notYet).toBe(summary.joinedCount - 2);
  });

  /** Three buckets that always account for the whole class, never more. */
  it("never reports more pupils in a bucket than have joined", () => {
    const summary = summariseClass(
      classOf(8, (i) => ({
        strugglingWith: i % 2 === 0 ? ["ʁ"] : [],
        secureWith: i % 2 === 1 ? ["ʁ"] : [],
      })),
    );

    if (!summary.reportable) throw new Error("expected a reportable summary");
    for (const sound of summary.sounds) {
      expect(sound.working + sound.secure + sound.notYet).toBe(summary.joinedCount);
    }
  });
});

describe("attendance", () => {
  it("counts practice days only, one count per day", () => {
    const summary = summariseClass([
      ...classOf(5),
      pupil("a", { days: ["2026-09-01", "2026-09-02"] }),
      pupil("b", { days: ["2026-09-02"] }),
    ]);

    if (!summary.reportable) throw new Error("expected a reportable summary");
    expect(summary.attendance).toEqual([
      { day: "2026-09-01", practisedCount: 1 },
      { day: "2026-09-02", practisedCount: 2 },
    ]);
  });

  it("counts a pupil once a day, however many takes they made", () => {
    const summary = summariseClass([
      ...classOf(5),
      pupil("a", { days: ["2026-09-01"] }),
      pupil("a", { days: ["2026-09-01"] }),
    ]);

    if (!summary.reportable) throw new Error("expected a reportable summary");
    expect(summary.attendance[0]?.practisedCount).toBe(1);
  });
});

describe("purity", () => {
  it("does not mutate the roll it was given", () => {
    const pupils = classOf(6, () => ({ strugglingWith: ["ʁ"], days: ["2026-09-01"] }));
    const before = JSON.stringify(pupils);

    summariseClass(pupils);

    expect(JSON.stringify(pupils)).toBe(before);
  });
});
