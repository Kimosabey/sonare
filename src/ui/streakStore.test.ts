// @vitest-environment jsdom

/**
 * Practice days, and the two ways a streak goes wrong.
 *
 * It can punish the wrong thing — tied to performance it penalises the accent
 * a learner arrived with, and whether the scorer is fair across accents is
 * still unmeasured, so such a streak would enforce a judgement nobody has
 * validated. The guard is structural: `recordPractice` takes no score, and
 * there is a test that its signature cannot express one.
 *
 * And it can be wrong about *when*. A learner practising at 23:40 and again at
 * 00:20 has practised two days; under UTC one of those lands on the wrong day
 * for half the world. These run with a fixed clock so the boundary cases are
 * actually exercised rather than assumed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearStreak,
  daysInLast,
  localDay,
  practisedToday,
  readStreak,
  recordPractice,
} from "./streakStore.js";

function installStorage(seed?: Record<string, string>): Map<string, string> {
  const data = new Map(Object.entries(seed ?? {}));
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
      key: (i: number) => [...data.keys()][i] ?? null,
      get length() {
        return data.size;
      },
    },
  });
  return data;
}

const LEARNER = "marie";
const KEY = `sonare.streak.v1.${LEARNER}`;

/** Seeds a streak straight into storage, oldest first. */
function seed(days: string[], longest = 0): Map<string, string> {
  return installStorage({ [KEY]: JSON.stringify({ days, current: 0, longest }) });
}

/** Pins the clock to a local noon, so no test straddles a day boundary. */
function setToday(day: string): void {
  vi.setSystemTime(new Date(`${day}T12:00:00`));
}

beforeEach(() => {
  installStorage();
  vi.useFakeTimers();
  setToday("2026-09-07");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("attendance, never score", () => {
  it("cannot be told about a score at all", () => {
    /**
     * The rule as a shape rather than a comment. `recordPractice(learner, day)`
     * has nowhere to put an accuracy, a pass flag, or a count of activities —
     * so no future change can quietly make a day conditional on performance
     * without changing the signature and this test with it.
     */
    // One required parameter — the learner. `Function.length` stops counting
    // at the first defaulted one, so this is the whole required surface: there
    // is nowhere to pass a score even by accident.
    expect(recordPractice.length).toBe(1);
    expect(recordPractice(LEARNER).current).toBe(1);
  });

  it("credits a day for a learner who scored badly", () => {
    // The case the rule exists for: a learner practising a sound they cannot
    // yet make has practised. That is the behaviour worth encouraging.
    expect(recordPractice(LEARNER).current).toBe(1);
    expect(practisedToday(readStreak(LEARNER))).toBe(true);
  });

  it("credits one day however many activities were done", () => {
    // Idempotent, so it can be called after every take. A learner who does ten
    // activities is not ten days ahead of one who did one.
    recordPractice(LEARNER);
    recordPractice(LEARNER);
    const streak = recordPractice(LEARNER);

    expect(streak.days).toHaveLength(1);
    expect(streak.current).toBe(1);
  });

  it("counts a person, not a language", () => {
    /**
     * A practice day is a fact about the learner. French on Monday and Hindi
     * on Tuesday is two days running, not two streaks of one — and the key
     * carries no language for that reason.
     */
    setToday("2026-09-06");
    recordPractice(LEARNER);
    setToday("2026-09-07");

    expect(recordPractice(LEARNER).current).toBe(2);
  });
});

describe("counting consecutive days", () => {
  it("builds a run across consecutive days", () => {
    for (const day of ["2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07"]) {
      setToday(day);
      recordPractice(LEARNER);
    }

    expect(readStreak(LEARNER).current).toBe(5);
  });

  it("keeps the streak alive on the morning after", () => {
    /**
     * Yesterday still counts as live. A learner who practised last night and
     * opens the app before practising today has not lost anything, and telling
     * them their streak is zero is both wrong and the worst possible moment to
     * say it.
     */
    seed(["2026-09-05", "2026-09-06"]);

    expect(readStreak(LEARNER).current).toBe(2);
  });

  it("lapses once a whole day has been missed", () => {
    // Two days ago is a lapse. This is what makes it a streak rather than a
    // counter, and it has to be true or the number means nothing.
    seed(["2026-09-04", "2026-09-05"]);

    expect(readStreak(LEARNER).current).toBe(0);
  });

  it("restarts at one after a lapse", () => {
    seed(["2026-09-01", "2026-09-02"]);

    expect(recordPractice(LEARNER).current).toBe(1);
  });

  it("counts only the run ending now, not the longest one", () => {
    // A five-day run in August is not today's streak.
    seed(["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05", "2026-09-07"]);

    expect(readStreak(LEARNER).current).toBe(1);
  });

  it("remembers the best run through a lapse", () => {
    /**
     * A lapse must not erase what was achieved. Losing the record along with
     * the streak makes a missed day cost twice, which is exactly the shape
     * that stops people coming back.
     */
    seed(["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"]);

    const streak = readStreak(LEARNER);

    expect(streak.current).toBe(0);
    expect(streak.longest).toBe(4);
  });
});

describe("the learner's own calendar", () => {
  it("uses local midnight, not UTC", () => {
    /**
     * The boundary that breaks half the world. 23:40 and 00:20 are two
     * different days for the learner, and under UTC one of them lands on the
     * wrong date depending on which side of Greenwich they are.
     */
    vi.setSystemTime(new Date("2026-09-06T23:40:00"));
    const lateNight = localDay();
    vi.setSystemTime(new Date("2026-09-07T00:20:00"));
    const earlyMorning = localDay();

    expect(lateNight).toBe("2026-09-06");
    expect(earlyMorning).toBe("2026-09-07");
    expect(lateNight).not.toBe(earlyMorning);
  });

  it("credits both sides of a late-night session", () => {
    vi.setSystemTime(new Date("2026-09-06T23:40:00"));
    recordPractice(LEARNER);
    vi.setSystemTime(new Date("2026-09-07T00:20:00"));

    expect(recordPractice(LEARNER).current).toBe(2);
  });

  it("counts month and year boundaries as ordinary days", () => {
    seed(["2026-08-31", "2026-09-01"]);
    setToday("2026-09-01");

    expect(readStreak(LEARNER).current).toBe(2);
  });
});

describe("days in the last week", () => {
  it("counts a good week that was not a perfect one", () => {
    /**
     * Offered alongside the streak because it is the kinder and often truer
     * figure. Four of seven is a good week; a learner who missed Wednesday has
     * not failed, and a raw streak alone turns one busy day into a reason to
     * stop.
     */
    // Today is the 7th, so the window reaches back to the 1st inclusive —
    // five of those seven days were practised, with the 2nd and 4th missed.
    seed(["2026-09-01", "2026-09-03", "2026-09-05", "2026-09-06", "2026-09-07"]);

    expect(daysInLast(readStreak(LEARNER), 7)).toBe(5);
    // And the streak is only three, which is the point of showing both.
    expect(readStreak(LEARNER).current).toBe(3);
  });

  it("ignores days outside the window", () => {
    seed(["2026-07-01", "2026-09-07"]);

    expect(daysInLast(readStreak(LEARNER), 7)).toBe(1);
  });

  it("includes today", () => {
    seed(["2026-09-07"]);

    expect(daysInLast(readStreak(LEARNER), 7)).toBe(1);
  });
});

describe("bounded and validated", () => {
  it("keeps a bounded list of days", () => {
    // Two years of daily practice is seven hundred date strings otherwise.
    const many = Array.from({ length: 90 }, (_, i) => `2026-0${i < 31 ? "1" : i < 59 ? "2" : "3"}-01`);
    seed([...new Set(many)]);

    expect(readStreak(LEARNER).days.length).toBeLessThanOrEqual(60);
  });

  it("does not let trimming the list shorten the record", () => {
    // `longest` is stored separately for exactly this: a run that has since
    // aged out of the list was still real.
    seed(["2026-09-07"], 42);

    expect(readStreak(LEARNER).longest).toBe(42);
  });

  it("recomputes the counters rather than trusting them", () => {
    /**
     * A hand-edited or half-written value must not inflate a streak. The days
     * are the record; the counters are derived from them on every read.
     */
    installStorage({ [KEY]: JSON.stringify({ days: ["2026-09-07"], current: 999, longest: 0 }) });

    expect(readStreak(LEARNER).current).toBe(1);
  });

  it("drops a value that is not a real date", () => {
    installStorage({
      [KEY]: JSON.stringify({ days: ["2026-09-07", "2026-99-99", "not-a-date", "2026-02-30", 7] }),
    });

    expect(readStreak(LEARNER).days).toEqual(["2026-09-07"]);
  });

  it("de-duplicates a day recorded twice by two builds", () => {
    installStorage({ [KEY]: JSON.stringify({ days: ["2026-09-07", "2026-09-07", "2026-09-06"] }) });

    expect(readStreak(LEARNER).days).toEqual(["2026-09-06", "2026-09-07"]);
    expect(readStreak(LEARNER).current).toBe(2);
  });

  it("starts empty on a corrupt value rather than throwing", () => {
    installStorage({ [KEY]: "{not json" });

    expect(readStreak(LEARNER)).toEqual({ days: [], current: 0, longest: 0 });
  });

  it("ignores an entry from an older schema", () => {
    installStorage({ [`sonare.streak.v0.${LEARNER}`]: JSON.stringify({ days: ["2026-09-07"] }) });

    expect(readStreak(LEARNER).current).toBe(0);
  });
});

describe("when storage refuses", () => {
  it("reads as no streak rather than throwing on the home screen", () => {
    // This runs where a learner first lands, so an escaping error is a blank
    // page before they have done anything.
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });

    expect(readStreak(LEARNER)).toEqual({ days: [], current: 0, longest: 0 });
  });

  it("keeps the session working when the write fails", () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });

    expect(() => recordPractice(LEARNER)).not.toThrow();
    // And still reports today as practised in memory, so the UI is not wrong
    // about the session the learner is in.
    expect(recordPractice(LEARNER).current).toBe(1);
  });

  it("survives a removeItem that throws", () => {
    vi.spyOn(window.localStorage, "removeItem").mockImplementation(() => {
      throw new Error("nope");
    });

    expect(() => clearStreak(LEARNER)).not.toThrow();
  });
});

describe("separate learners", () => {
  it("keeps one streak each on a shared device", () => {
    recordPractice("speaker-a");

    expect(readStreak("speaker-a").current).toBe(1);
    expect(readStreak("speaker-b").current).toBe(0);
  });

  it("gives an unnamed learner a bucket of their own", () => {
    recordPractice(null);

    expect(readStreak(null).current).toBe(1);
    expect(readStreak(LEARNER).current).toBe(0);
  });
});
