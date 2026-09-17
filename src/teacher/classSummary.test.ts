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
  return { pupilId: id, standing: {}, days: [], ...over };
}

/** Every named grapheme at one standing, which is what most cases need. */
function at(standing: PupilPractice["standing"][string], ...graphemes: string[]) {
  return Object.fromEntries(graphemes.map((g) => [g, standing]));
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
      standing: { ...at("getting-there", ...["ʁ", "u"].slice(0, (i % 2) + 1)), ...at("holding", "a") },
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
      classOf(9, () => ({ standing: { ...at("getting-there", "ʁ"), ...at("holding", "a") }, days: ["2026-09-01"] })),
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
      classOf(MIN_REPORTABLE_CLASS - 1, () => ({ standing: at("getting-there", "ʁ") })),
    );

    expect(summary.reportable).toBe(false);
    if (summary.reportable) throw new Error("expected a withheld summary");
    expect(summary.reason).toBe("class-too-small");
    expect(summary.joinedCount).toBe(MIN_REPORTABLE_CLASS - 1);
  });

  it("reports at the floor exactly", () => {
    const summary = summariseClass(
      classOf(MIN_REPORTABLE_CLASS, () => ({ standing: at("getting-there", "ʁ") })),
    );

    expect(summary.reportable).toBe(true);
  });

  /**
   * The withheld shape carries no sounds and no attendance at all, rather than
   * empty arrays. A view handed `sounds: []` would render an empty table, and
   * a teacher reads an empty difficulty table as "nobody is struggling".
   */
  it("withholds the figures themselves, not merely a flag", () => {
    const summary = summariseClass([pupil("a", { standing: at("getting-there", "ʁ"), days: ["2026-09-01"] })]);

    expect(JSON.stringify(summary)).not.toContain("ʁ");
    expect(JSON.stringify(summary)).not.toContain("2026-09-01");
  });

  /**
   * Two records for one pupil must not inflate the class past the floor —
   * larger is the direction that wrongly unlocks reporting.
   */
  it("counts distinct pupils, so duplicates cannot unlock reporting", () => {
    const duplicated = Array.from({ length: MIN_REPORTABLE_CLASS + 3 }, () =>
      pupil("the-same-pupil", { standing: at("getting-there", "ʁ") }),
    );

    expect(summariseClass(duplicated).reportable).toBe(false);
  });
});

describe("sound difficulty", () => {
  it("counts pupils working on a sound, never an average", () => {
    const summary = summariseClass([
      ...classOf(3, () => ({ standing: at("getting-there", "ʁ") })),
      ...classOf(4, () => ({ standing: at("holding", "ʁ") })).map((p, i) => ({
        ...p,
        pupilId: `s${i}`,
      })),
    ]);

    if (!summary.reportable) throw new Error("expected a reportable summary");
    const r = summary.sounds.find((s) => s.grapheme === "ʁ");
    expect(r?.working).toBe(3);
    expect(r?.holding).toBe(4);
  });

  /**
   * The board: "Rows are ordered by that count and the order is fixed; there
   * is no sort control, because the only other thing to sort by does not exist
   * here."
   */
  it("orders by how many are working on it, hardest first", () => {
    const summary = summariseClass([
      ...classOf(6, (i) => ({ standing: i < 5 ? at("getting-there", "ʁ", "u") : at("getting-there", "u") })),
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
      pupil("a", { standing: at("getting-there", "u", "ʁ", "e") }),
      pupil("b", { standing: at("getting-there", "e", "u", "ʁ") }),
      pupil("c", { standing: at("getting-there", "ʁ", "e", "u") }),
      pupil("d", { standing: at("getting-there", "ʁ", "u", "e") }),
      pupil("e", { standing: at("getting-there", "e", "ʁ", "u") }),
      pupil("f", { standing: at("getting-there", "u", "e", "ʁ") }),
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
      pupil("dup", { standing: at("getting-there", "ʁ") }),
      pupil("dup", { standing: at("getting-there", "ʁ") }),
    ]);

    if (!summary.reportable) throw new Error("expected a reportable summary");
    expect(summary.sounds.find((s) => s.grapheme === "ʁ")?.working).toBe(1);
  });

  /**
   * A standing this build does not know is dropped rather than bucketed. It
   * can only come from a newer writer, and inventing a bucket would put a
   * pupil in a column that does not describe them — while counting it as
   * "working" would inflate the figure a teacher plans a lesson from.
   */
  it("ignores a standing it does not recognise", () => {
    const summary = summariseClass([
      ...classOf(5),
      pupil("odd", {
        standing: { "ʁ": "brand-new-bucket" as PupilPractice["standing"][string] },
      }),
    ]);

    if (!summary.reportable) throw new Error("expected a reportable summary");
    expect(summary.sounds.find((s) => s.grapheme === "ʁ")).toBeUndefined();
  });

  it("accounts for pupils who have not reached a sound at all", () => {
    const summary = summariseClass([
      ...classOf(5),
      pupil("x", { standing: at("getting-there", "ʁ") }),
      pupil("y", { standing: at("holding", "ʁ") }),
    ]);

    if (!summary.reportable) throw new Error("expected a reportable summary");
    const r = summary.sounds.find((s) => s.grapheme === "ʁ");
    expect(r?.notYet).toBe(summary.joinedCount - 2);
  });

  /** Three buckets that always account for the whole class, never more. */
  it("never reports more pupils in a bucket than have joined", () => {
    const summary = summariseClass(
      classOf(8, (i) => ({
        standing: at(i % 2 === 0 ? "getting-there" : "holding", "ʁ"),
      })),
    );

    if (!summary.reportable) throw new Error("expected a reportable summary");
    for (const sound of summary.sounds) {
      expect(sound.working + sound.holding + sound.notYet).toBe(summary.joinedCount);
    }
  });
});

describe("the three buckets", () => {
  /**
   * All three at once. The refactor that introduced them mapped every existing
   * case onto `getting-there`, so for a while nothing exercised the other two
   * and four mutations survived — including deleting `just-started` entirely.
   */
  it("counts each standing separately", () => {
    const summary = summariseClass([
      ...classOf(2, () => ({ standing: at("just-started", "ʁ") })),
      ...classOf(3, () => ({ standing: at("getting-there", "ʁ") })).map((p, i) => ({
        ...p,
        pupilId: `g${i}`,
      })),
      ...classOf(4, () => ({ standing: at("holding", "ʁ") })).map((p, i) => ({
        ...p,
        pupilId: `h${i}`,
      })),
    ]);

    if (!summary.reportable) throw new Error("expected a reportable summary");
    const r = summary.sounds.find((sound) => sound.grapheme === "ʁ");
    expect(r?.justStarted).toBe(2);
    expect(r?.gettingThere).toBe(3);
    expect(r?.holding).toBe(4);
  });

  /**
   * The board's own arithmetic: its sound detail shows 9 just-started and 13
   * getting-there, and its overview prints "22 of 28 still working on it". The
   * overview figure is the first two buckets and nothing else — counting only
   * `getting-there` would under-report the class problem a lesson is planned
   * from, and including `holding` would over-report it.
   */
  it("reports still-working as just-started plus getting-there, and not holding", () => {
    const summary = summariseClass([
      ...classOf(9, () => ({ standing: at("just-started", "ʁ") })),
      ...classOf(13, () => ({ standing: at("getting-there", "ʁ") })).map((p, i) => ({
        ...p,
        pupilId: `g${i}`,
      })),
      ...classOf(6, () => ({ standing: at("holding", "ʁ") })).map((p, i) => ({
        ...p,
        pupilId: `h${i}`,
      })),
    ]);

    if (!summary.reportable) throw new Error("expected a reportable summary");
    const r = summary.sounds.find((sound) => sound.grapheme === "ʁ");
    expect(summary.joinedCount).toBe(28);
    expect(r?.working).toBe(22);
  });

  /**
   * Ordering, with a case where difficulty and code point disagree. The
   * earlier test happened to want the same answer both ways, so removing the
   * difficulty term from the sort changed nothing and the mutation survived.
   */
  it("orders by difficulty even when that contradicts the alphabet", () => {
    const summary = summariseClass([
      // "a" sorts first by code point but is the easiest sound here.
      ...classOf(6, (i) => ({
        standing: {
          ...at("holding", "a"),
          ...(i < 5 ? at("just-started", "ʁ") : {}),
        },
      })),
    ]);

    if (!summary.reportable) throw new Error("expected a reportable summary");
    expect(summary.sounds.map((sound) => sound.grapheme)).toEqual(["ʁ", "a"]);
  });

  /**
   * Two records for one pupil can put them in two buckets — two devices, or a
   * sync mid-change. The buckets then sum past the class, and `notYet` is
   * floored rather than allowed to go negative: a negative count rendered as a
   * bar is a shape that describes no class at all.
   */
  it("never reports a negative not-yet count", () => {
    // Every pupil appears twice, in two different buckets, so the buckets sum
    // to twice the class. One duplicated pupil is not enough to drive the
    // subtraction negative — an earlier version of this test used one, and the
    // mutation that removed the floor survived it.
    const ids = ["a", "b", "c", "d", "e"];
    const summary = summariseClass([
      ...ids.map((id) => pupil(id, { standing: at("just-started", "ʁ") })),
      ...ids.map((id) => pupil(id, { standing: at("holding", "ʁ") })),
    ]);

    if (!summary.reportable) throw new Error("expected a reportable summary");
    const r = summary.sounds.find((sound) => sound.grapheme === "ʁ");
    expect(summary.joinedCount).toBe(5);
    expect(r?.justStarted).toBe(5);
    expect(r?.holding).toBe(5);
    expect(r?.notYet).toBe(0);
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
    const pupils = classOf(6, () => ({ standing: at("getting-there", "ʁ"), days: ["2026-09-01"] }));
    const before = JSON.stringify(pupils);

    summariseClass(pupils);

    expect(JSON.stringify(pupils)).toBe(before);
  });
});
