/**
 * The merge rule that must not be got wrong.
 *
 * Under last-write-wins a phone that synced yesterday overwrites a tablet that
 * practised today, and a real practice day is deleted. That is the most
 * damaging thing a streak can do and it is completely silent: the learner
 * finds their streak shorter than they know it to be, with no way to argue and
 * nothing on any screen looking broken.
 *
 * Two other properties are pinned here. The record survives a lapse and a
 * trim, because losing the achievement along with the streak makes a missed
 * day cost twice — the shape that stops people coming back. And the server
 * never computes the current run, because it cannot: it does not know the
 * learner's timezone.
 */

import { describe, expect, it } from "vitest";
import { longestRun, mergeStreaks, readStreakState, type StreakState } from "./merge.js";

function streak(days: string[], longest = 0): StreakState {
  return { days, longest };
}

describe("a practised day is never deleted", () => {
  it("unions two devices' days", () => {
    const phone = streak(["2026-09-05", "2026-09-06"]);
    const tablet = streak(["2026-09-07"]);

    expect(mergeStreaks(phone, tablet).days).toEqual(["2026-09-05", "2026-09-06", "2026-09-07"]);
  });

  it("does not let a stale device erase today", () => {
    /**
     * The exact failure. The phone synced yesterday and knows nothing of
     * today; pushing it must add nothing and remove nothing.
     */
    const stale = streak(["2026-09-05", "2026-09-06"]);
    const current = streak(["2026-09-05", "2026-09-06", "2026-09-07"]);

    expect(mergeStreaks(stale, current).days).toContain("2026-09-07");
    expect(mergeStreaks(current, stale).days).toContain("2026-09-07");
  });

  it("commutes", () => {
    const a = streak(["2026-09-01", "2026-09-03", "2026-09-07"], 3);
    const b = streak(["2026-09-02", "2026-09-03"], 2);

    expect(mergeStreaks(a, b)).toEqual(mergeStreaks(b, a));
  });

  it("is idempotent", () => {
    const a = streak(["2026-09-05", "2026-09-06"], 2);

    expect(mergeStreaks(mergeStreaks(a, a), a)).toEqual(mergeStreaks(a, a));
  });

  it("counts a day recorded on both devices once", () => {
    expect(mergeStreaks(streak(["2026-09-07"]), streak(["2026-09-07"])).days).toEqual(["2026-09-07"]);
  });

  it("joins two partial runs into the real one", () => {
    // Practising on whichever device was to hand should produce one run, not
    // two broken halves.
    const phone = streak(["2026-09-01", "2026-09-03", "2026-09-05"]);
    const laptop = streak(["2026-09-02", "2026-09-04"]);

    const merged = mergeStreaks(phone, laptop);

    expect(merged.days).toHaveLength(5);
    expect(merged.longest).toBe(5);
  });
});

describe("the record survives", () => {
  it("keeps the better of the two devices' records", () => {
    expect(mergeStreaks(streak(["2026-09-07"], 12), streak(["2026-09-07"], 5)).longest).toBe(12);
  });

  it("keeps a record neither device still has days for", () => {
    /**
     * A run that has aged out of the capped list was still real, and neither
     * device may be the one that remembers it. Recomputing from days alone
     * would quietly demote a learner's best week.
     */
    expect(mergeStreaks(streak([], 30), streak(["2026-09-07"], 0)).longest).toBe(30);
  });

  it("recognises a record the merged days reveal", () => {
    // Neither device alone had the run; together they do.
    const a = streak(["2026-09-01", "2026-09-02"], 2);
    const b = streak(["2026-09-03", "2026-09-04"], 2);

    expect(mergeStreaks(a, b).longest).toBe(4);
  });

  it("does not let the cap shorten a record", () => {
    // The run is computed over the untrimmed union, then the list is trimmed.
    const long = Array.from({ length: 70 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 5, 1) + i * 86_400_000);
      return d.toISOString().slice(0, 10);
    });

    const merged = mergeStreaks(streak(long), streak([]));

    expect(merged.days).toHaveLength(60);
    expect(merged.longest).toBe(70);
  });

  it("trims the oldest days, never one device's share", () => {
    const merged = mergeStreaks(
      streak(Array.from({ length: 40 }, (_, i) => new Date(Date.UTC(2026, 5, 1) + i * 86_400_000).toISOString().slice(0, 10))),
      streak(Array.from({ length: 40 }, (_, i) => new Date(Date.UTC(2026, 6, 11) + i * 86_400_000).toISOString().slice(0, 10))),
    );

    expect(merged.days).toHaveLength(60);
    // The most recent day from the later device is definitely kept.
    expect(merged.days[59]).toBe(new Date(Date.UTC(2026, 6, 11) + 39 * 86_400_000).toISOString().slice(0, 10));
  });
});

describe("counting runs", () => {
  it("counts consecutive days", () => {
    expect(longestRun(["2026-09-01", "2026-09-02", "2026-09-03"])).toBe(3);
  });

  it("breaks on a gap", () => {
    expect(longestRun(["2026-09-01", "2026-09-02", "2026-09-04", "2026-09-05", "2026-09-06"])).toBe(3);
  });

  it("crosses a month boundary as an ordinary day", () => {
    expect(longestRun(["2026-08-30", "2026-08-31", "2026-09-01"])).toBe(3);
  });

  it("crosses a year boundary", () => {
    expect(longestRun(["2026-12-31", "2027-01-01"])).toBe(2);
  });

  it("counts a leap day", () => {
    expect(longestRun(["2028-02-28", "2028-02-29", "2028-03-01"])).toBe(3);
  });

  it("is zero for no days", () => {
    expect(longestRun([])).toBe(0);
  });
});

describe("what the server does not know", () => {
  it("carries no current run, because the learner's timezone is unknown", () => {
    /**
     * A structural check on a real limitation. A request at 23:40 in Auckland
     * and one at 23:40 in Lisbon are indistinguishable here, so a `current`
     * computed server-side would be wrong for most of the world for part of
     * every day. The client derives it against its own clock.
     */
    const merged = mergeStreaks(streak(["2026-09-07"]), streak([]));

    expect(Object.keys(merged).sort()).toEqual(["days", "longest"]);
    expect("current" in merged).toBe(false);
  });
});

describe("reading what a client sent", () => {
  it("drops values that are not real dates", () => {
    const read = readStreakState({
      days: ["2026-09-07", "2026-99-99", "not-a-date", "2026-02-30", 7, null, "2026-9-7"],
    });

    expect(read?.days).toEqual(["2026-09-07"]);
  });

  it("accepts a leap day but not a fake one", () => {
    expect(readStreakState({ days: ["2028-02-29"] })?.days).toEqual(["2028-02-29"]);
    expect(readStreakState({ days: ["2026-02-29"] })?.days).toEqual([]);
  });

  it("de-duplicates and sorts", () => {
    expect(readStreakState({ days: ["2026-09-07", "2026-09-05", "2026-09-07"] })?.days).toEqual([
      "2026-09-05",
      "2026-09-07",
    ]);
  });

  it("does not trust a claimed record beyond what is plausible", () => {
    // A client claiming a longest of a million with three days stored is
    // either broken or hand-edited.
    expect(readStreakState({ days: ["2026-09-07"], longest: 1e9 })?.longest).toBe(100_000);
    expect(readStreakState({ days: ["2026-09-07"], longest: -5 })?.longest).toBe(1);
    expect(readStreakState({ days: ["2026-09-07"], longest: "many" })?.longest).toBe(1);
  });

  it("floors a record the days already justify", () => {
    // A client that under-reports its own record must not lose it.
    expect(readStreakState({ days: ["2026-09-05", "2026-09-06", "2026-09-07"], longest: 0 })?.longest).toBe(3);
  });

  it("bounds how many days one push can store", () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
    );

    expect(readStreakState({ days: many })?.days).toHaveLength(60);
  });

  it("rejects a state with no day list", () => {
    expect(readStreakState({ longest: 5 })).toBeNull();
    expect(readStreakState(null)).toBeNull();
    expect(readStreakState("streak")).toBeNull();
  });
});
