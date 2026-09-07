/**
 * The merge rules, which are the whole design of sync.
 *
 * A blanket last-write-wins would be wrong for most of this, and wrong in the
 * way that costs the most: silent, invisible on one device, and only ever
 * losing work the learner actually did. So each rule is tested for what it
 * prevents, not just for what it computes.
 *
 * Commutativity is asserted explicitly. If merging depends on which device
 * pushed first then there is a conflict to resolve, and the whole
 * no-conflict-UI premise collapses.
 */

import { describe, expect, it } from "vitest";
import {
  isSlug,
  mergeEntry,
  mergeProgress,
  readProgressEntry,
  readProgressState,
  type ProgressEntry,
  type ProgressState,
} from "./merge.js";

function entry(over: Partial<ProgressEntry> = {}): ProgressEntry {
  return {
    activityId: 1,
    passed: false,
    bestAccuracy: null,
    attemptsUsed: 0,
    skipped: false,
    at: "2026-09-07T10:00:00.000Z",
    ...over,
  };
}

function state(entries: ProgressEntry[], slug = "fr"): ProgressState {
  return { slug, entries };
}

describe("passing is never undone", () => {
  it("keeps a pass recorded on either device", () => {
    /**
     * The damaging case. A phone that synced before the learner passed the
     * activity would, under last-write-wins, overwrite the tablet that
     * recorded the pass — and the learner would find work they had done
     * undone, with nothing looking broken.
     */
    const passed = entry({ passed: true, bestAccuracy: 82 });
    const not = entry({ passed: false, bestAccuracy: 41 });

    expect(mergeEntry(passed, not).passed).toBe(true);
    expect(mergeEntry(not, passed).passed).toBe(true);
  });

  it("does not invent a pass neither device recorded", () => {
    expect(mergeEntry(entry(), entry()).passed).toBe(false);
  });
});

describe("the best score is a best", () => {
  it("takes the higher of the two", () => {
    expect(mergeEntry(entry({ bestAccuracy: 61 }), entry({ bestAccuracy: 88 })).bestAccuracy).toBe(88);
  });

  it("never averages them", () => {
    // Averaging would produce a number no provider ever returned, which R3
    // forbids: the score shown comes from the assessment or it is not shown.
    expect(mergeEntry(entry({ bestAccuracy: 60 }), entry({ bestAccuracy: 90 })).bestAccuracy).toBe(90);
  });

  it("treats never-scored as no claim, not as zero", () => {
    // Zero is a score a learner could earn. Null means nothing was measured,
    // and conflating them would let an unscored device drag a real best down.
    expect(mergeEntry(entry({ bestAccuracy: null }), entry({ bestAccuracy: 55 })).bestAccuracy).toBe(55);
    expect(mergeEntry(entry({ bestAccuracy: 55 }), entry({ bestAccuracy: null })).bestAccuracy).toBe(55);
    expect(mergeEntry(entry({ bestAccuracy: null }), entry({ bestAccuracy: null })).bestAccuracy).toBeNull();
  });

  it("keeps a genuine zero", () => {
    expect(mergeEntry(entry({ bestAccuracy: 0 }), entry({ bestAccuracy: null })).bestAccuracy).toBe(0);
  });
});

describe("attempts are the same learner's, not two learners'", () => {
  it("takes the maximum rather than the sum", () => {
    /**
     * Two devices each recording two attempts is not four tries against a
     * limit of three. Summing would lock a learner out of an activity they
     * still have tries left on — and they would have no way to tell why.
     */
    expect(mergeEntry(entry({ attemptsUsed: 2 }), entry({ attemptsUsed: 2 })).attemptsUsed).toBe(2);
    expect(mergeEntry(entry({ attemptsUsed: 1 }), entry({ attemptsUsed: 3 })).attemptsUsed).toBe(3);
  });
});

describe("skipping survives only agreement", () => {
  it("clears a skip when the other device passed it", () => {
    // A learner who skipped on the bus and later went back and passed on a
    // laptop has passed it. Keeping the skip would misreport their own work.
    const skipped = entry({ skipped: true });
    const done = entry({ skipped: false, passed: true });

    expect(mergeEntry(skipped, done).skipped).toBe(false);
    expect(mergeEntry(done, skipped).skipped).toBe(false);
  });

  it("keeps a skip both devices agree on", () => {
    expect(mergeEntry(entry({ skipped: true }), entry({ skipped: true })).skipped).toBe(true);
  });
});

describe("timestamps", () => {
  it("keeps the later attempt time", () => {
    const older = entry({ at: "2026-09-01T10:00:00.000Z" });
    const newer = entry({ at: "2026-09-07T10:00:00.000Z" });

    expect(mergeEntry(older, newer).at).toBe("2026-09-07T10:00:00.000Z");
    expect(mergeEntry(newer, older).at).toBe("2026-09-07T10:00:00.000Z");
  });
});

describe("merging a whole language", () => {
  it("keeps activities only one device has seen", () => {
    // The other device has not seen it, which is not evidence against it.
    const mine = state([entry({ activityId: 1, passed: true })]);
    const theirs = state([entry({ activityId: 2, passed: true })]);

    const merged = mergeProgress(mine, theirs);

    expect(merged.entries.map((e) => e.activityId)).toEqual([1, 2]);
    expect(merged.entries.every((e) => e.passed)).toBe(true);
  });

  it("merges the ones both have seen", () => {
    const mine = state([entry({ activityId: 1, passed: true, bestAccuracy: 70 })]);
    const theirs = state([entry({ activityId: 1, passed: false, bestAccuracy: 91 })]);

    expect(mergeProgress(mine, theirs).entries[0]).toMatchObject({
      activityId: 1,
      passed: true,
      bestAccuracy: 91,
    });
  });

  it("produces the same result whichever device pushed first", () => {
    /**
     * The property the whole design rests on. If the outcome depends on order
     * then there is a conflict, and a conflict needs someone to resolve it —
     * which for a learner's own practice history is an absurd thing to ask.
     */
    const mine = state([
      entry({ activityId: 1, passed: true, bestAccuracy: 70, attemptsUsed: 2 }),
      entry({ activityId: 3, skipped: true, attemptsUsed: 3, at: "2026-09-02T10:00:00.000Z" }),
    ]);
    const theirs = state([
      entry({ activityId: 1, passed: false, bestAccuracy: 91, attemptsUsed: 1 }),
      entry({ activityId: 2, passed: true, bestAccuracy: 65 }),
      entry({ activityId: 3, skipped: false, passed: true, at: "2026-09-06T10:00:00.000Z" }),
    ]);

    expect(mergeProgress(mine, theirs)).toEqual(mergeProgress(theirs, mine));
  });

  it("is idempotent, so a repeated push changes nothing", () => {
    // A retry after a timeout must not double anything.
    const mine = state([entry({ activityId: 1, passed: true, attemptsUsed: 2, bestAccuracy: 70 })]);

    const once = mergeProgress(mine, state([]));
    const twice = mergeProgress(once, mine);

    expect(twice).toEqual(once);
  });

  it("sorts entries, so identical facts give an identical document", () => {
    // Without a canonical order the same state has many representations, and
    // "did anything actually change" can never be a cheap comparison.
    const mine = state([entry({ activityId: 9 }), entry({ activityId: 2 })]);
    const theirs = state([entry({ activityId: 5 })]);

    expect(mergeProgress(mine, theirs).entries.map((e) => e.activityId)).toEqual([2, 5, 9]);
  });

  it("handles an empty side", () => {
    const mine = state([entry({ activityId: 1, passed: true })]);

    expect(mergeProgress(mine, state([]))).toEqual(mine);
    expect(mergeProgress(state([]), mine).entries).toEqual(mine.entries);
  });
});

describe("reading what a client sent", () => {
  it("accepts a well-formed entry", () => {
    expect(readProgressEntry({ activityId: 3, passed: true, bestAccuracy: 77, attemptsUsed: 2, skipped: false, at: "2026-09-07T10:00:00.000Z" })).toEqual({
      activityId: 3,
      passed: true,
      bestAccuracy: 77,
      attemptsUsed: 2,
      skipped: false,
      at: "2026-09-07T10:00:00.000Z",
    });
  });

  it("clamps a score outside the possible range", () => {
    /**
     * This is displayed to a learner as their best, and it is a MAX — so an
     * impossible 8000 would render as nonsense and could never be displaced
     * by a real score. The value arrives from a client that can send anything.
     */
    expect(readProgressEntry(entry({ bestAccuracy: 8000 }))?.bestAccuracy).toBe(100);
    expect(readProgressEntry(entry({ bestAccuracy: -50 }))?.bestAccuracy).toBe(0);
  });

  it("clamps an absurd attempt count", () => {
    // A MAX that would either do nothing or lock the activity permanently.
    expect(readProgressEntry(entry({ attemptsUsed: -3 }))?.attemptsUsed).toBe(0);
    expect(readProgressEntry(entry({ attemptsUsed: 1e9 }))?.attemptsUsed).toBe(999);
  });

  it("treats a non-boolean flag as false rather than truthy", () => {
    // `"false"` and `1` are both truthy, and either would silently mark an
    // activity passed.
    expect(readProgressEntry({ ...entry(), passed: "false" })?.passed).toBe(false);
    expect(readProgressEntry({ ...entry(), passed: 1 })?.passed).toBe(false);
  });

  it.each([
    ["null", null],
    ["a string", "progress"],
    ["no activityId", { passed: true, at: "2026-09-07T10:00:00.000Z" }],
    ["NaN activityId", { activityId: Number.NaN, at: "2026-09-07T10:00:00.000Z" }],
    ["no timestamp", { activityId: 1 }],
    ["an enormous timestamp", { activityId: 1, at: "x".repeat(500) }],
  ])("rejects %s", (_label, raw) => {
    expect(readProgressEntry(raw)).toBeNull();
  });

  it("keeps a slug to a plausible shape", () => {
    expect(isSlug("fr")).toBe(true);
    expect(isSlug("french")).toBe(true);
    for (const bad of ["", "FR", "fr-FR", "../etc", "a".repeat(40), 7, null, { $ne: null }]) {
      expect(isSlug(bad)).toBe(false);
    }
  });

  it("drops bad entries without losing the good ones", () => {
    const read = readProgressState({
      slug: "fr",
      entries: [entry({ activityId: 1 }), null, "nonsense", entry({ activityId: 2 })],
    });

    expect(read?.entries.map((e) => e.activityId)).toEqual([1, 2]);
  });

  it("bounds how much one push can store", () => {
    const many = Array.from({ length: 500 }, (_, i) => entry({ activityId: i }));

    expect(readProgressState({ slug: "fr", entries: many })?.entries).toHaveLength(200);
  });

  it("rejects a state with no usable slug", () => {
    expect(readProgressState({ slug: "../../x", entries: [] })).toBeNull();
    expect(readProgressState({ entries: [] })).toBeNull();
    expect(readProgressState({ slug: "fr" })).toBeNull();
  });
});
