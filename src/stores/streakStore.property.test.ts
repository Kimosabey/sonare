// @vitest-environment jsdom

/**
 * T33 — practice-day arithmetic across every timezone, both DST boundaries,
 * and a clock that runs backwards.
 *
 * A streak is a claim about the *learner's* calendar, so `streakStore`
 * computes days locally: `new Date("2026-03-08T00:00:00")` is local midnight,
 * and the gap between two consecutive local midnights is 24 hours — except on
 * the day a region changes its clocks, when it is 23, 25, 23.5 or 24.5. The
 * clamp is `Math.round` in `daysBetween`, and this file exists because that
 * one call is the whole defence: `Math.floor` there would break every streak
 * in the northern hemisphere on the morning the clocks go forward, in a way
 * that reproduces for one day a year in some timezones and never on the
 * machine the code was written on.
 *
 * Two things make this stronger than a handful of chosen dates.
 *
 * First, a reference model. The expectations below are computed from the day
 * *strings* using UTC arithmetic, which has no DST at all and therefore
 * cannot share the store's bug. Any disagreement between the two is a
 * timezone defect by construction.
 *
 * Second, exhaustion where exhaustion is cheap. Every IANA timezone Node
 * knows, over every day of 2026, is a few thousand cases and runs in well
 * under a second — so it is swept rather than sampled, and no transition in
 * any region can be the one nobody thought of.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearStreak,
  daysInLast,
  localDay,
  practisedToday,
  readStreak,
  recordPractice,
  writeStreak,
} from "./streakStore.js";
import { chance, intBetween, listOf, makeRng, pickFrom } from "../testing/rng.js";

const SEED_DAYS = 0x5eed_da75;
const SEED_CLOCK = 0x5eed_c10c;

/** Mirrors the store's own constants, named so the tests read as the rule. */
const MAX_DAYS = 60;
const LEARNER = "marie";
const KEY = `sonare.streak.v1.${LEARNER}`;

/**
 * The timezone is set through `globalThis` rather than `import "node:process"`.
 *
 * This file is typechecked by tsconfig.json — the client project, which has no
 * Node types on purpose, because a `src/` file that could import `node:fs` is
 * a `src/` file that could reach the filesystem. The env var is still the only
 * way to relocate the clock: Node consults `TZ` on each date operation, so
 * assigning it mid-run genuinely moves the calendar under the code being
 * tested.
 */
interface EnvHolder {
  env: Record<string, string | undefined>;
}
const nodeEnv = (globalThis as unknown as { process: EnvHolder }).process.env;
const ORIGINAL_TZ = nodeEnv["TZ"];

function inZone(zone: string): void {
  nodeEnv["TZ"] = zone;
}

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete nodeEnv["TZ"];
  else nodeEnv["TZ"] = ORIGINAL_TZ;
});

/**
 * A real in-memory Storage.
 *
 * jsdom's own `localStorage` is a bare object with no methods here, so the
 * store's `getItem` call throws and every read silently returns EMPTY — which
 * would make this whole file pass while testing nothing.
 */
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

beforeEach(() => {
  installStorage();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── the reference model ──────────────────────────────────────────────────────

/**
 * Days since the epoch for a `YYYY-MM-DD` string, in UTC.
 *
 * Deliberately not the store's arithmetic. UTC has no DST, so this is exact
 * by construction — which is what makes it a reference rather than a second
 * opinion.
 */
function utcDayNumber(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1) / 86_400_000;
}

/** The store's `currentRun`, restated over UTC day numbers. */
function refCurrent(days: string[], today: string): number {
  if (days.length === 0) return 0;
  const last = days[days.length - 1] as string;
  if (utcDayNumber(today) - utcDayNumber(last) > 1) return 0;
  let run = 1;
  for (let i = days.length - 1; i > 0; i -= 1) {
    if (utcDayNumber(days[i] as string) - utcDayNumber(days[i - 1] as string) !== 1) break;
    run += 1;
  }
  return run;
}

/** The store's `longestRun`, restated over UTC day numbers. */
function refLongest(days: string[]): number {
  let best = 0;
  let run = 0;
  for (let i = 0; i < days.length; i += 1) {
    run = i > 0 && utcDayNumber(days[i] as string) - utcDayNumber(days[i - 1] as string) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}

/** The store's normalisation of a stored day list. */
function refDays(days: string[]): string[] {
  return [...new Set(days)].sort().slice(-MAX_DAYS);
}

// ── calendars ────────────────────────────────────────────────────────────────

/** Every day of 2026 as `YYYY-MM-DD`, oldest first. */
function everyDayOf2026(): string[] {
  const out: string[] = [];
  for (let month = 1; month <= 12; month += 1) {
    const lastOfMonth = new Date(Date.UTC(2026, month, 0)).getUTCDate();
    for (let day = 1; day <= lastOfMonth; day += 1) {
      out.push(`2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
    }
  }
  return out;
}

/** `count` consecutive days starting at `from`. */
function runFrom(from: string, count: number): string[] {
  const start = utcDayNumber(from);
  return listOf(count, (i) => new Date((start + i) * 86_400_000).toISOString().slice(0, 10));
}

/**
 * Every timezone this Node knows about.
 *
 * The point of using all of them rather than a chosen dozen is that DST rules
 * are political: Lord Howe shifts by thirty minutes, Havana and Santiago
 * change at local midnight so that midnight itself does not exist that day,
 * and the list changes between Node releases. A curated list is a list of the
 * transitions someone already thought about.
 */
const ALL_ZONES: readonly string[] = Intl.supportedValuesOf("timeZone");

/**
 * The transitions worth naming, with the shape of each.
 *
 * Kept alongside the exhaustive sweep because a named case says *what* broke
 * when it breaks, where the sweep only says that something did.
 */
const NAMED_TRANSITIONS: ReadonlyArray<{ zone: string; day: string; note: string }> = [
  { zone: "America/New_York", day: "2026-03-08", note: "spring forward, 23-hour day" },
  { zone: "America/New_York", day: "2026-11-01", note: "fall back, 25-hour day" },
  { zone: "Europe/Berlin", day: "2026-03-29", note: "spring forward, 23-hour day" },
  { zone: "Europe/Berlin", day: "2026-10-25", note: "fall back, 25-hour day" },
  { zone: "Australia/Lord_Howe", day: "2026-10-04", note: "spring forward, 23.5-hour day" },
  { zone: "Australia/Lord_Howe", day: "2026-04-05", note: "fall back, 24.5-hour day" },
  { zone: "America/Havana", day: "2026-03-08", note: "local midnight does not exist" },
  { zone: "America/Santiago", day: "2026-09-06", note: "local midnight does not exist" },
  { zone: "Pacific/Chatham", day: "2026-09-27", note: "spring forward on a 45-minute offset" },
  { zone: "Asia/Kolkata", day: "2026-03-08", note: "half-hour offset, no DST" },
  { zone: "UTC", day: "2026-03-08", note: "the control" },
];

describe("a day is the learner's own calendar day, in every timezone", () => {
  it(`round-trips every day of 2026 through localDay in all ${ALL_ZONES.length} timezones`, () => {
    /**
     * `isDay()` validates a stored day by parsing it and asking `localDay()`
     * to reproduce it. A day that fails that round-trip is silently dropped
     * from the learner's history — so in a timezone where local midnight does
     * not exist (Havana, Santiago), a naive parse would delete one practice
     * day a year for everyone in the country, and the streak would break
     * with no error anywhere.
     */
    const days = everyDayOf2026();
    expect(days).toHaveLength(365);
    expect(ALL_ZONES.length).toBeGreaterThan(300);

    let checked = 0;
    for (const zone of ALL_ZONES) {
      inZone(zone);
      for (const day of days) {
        const parsed = new Date(`${day}T00:00:00`);
        expect(Number.isNaN(parsed.getTime()), `${zone} ${day}`).toBe(false);
        expect(localDay(parsed), `${zone} ${day}`).toBe(day);
        checked += 1;
      }
    }
    expect(checked).toBe(ALL_ZONES.length * 365);
  });

  it("reads back a full 60-day history unchanged, everywhere, all year", () => {
    /**
     * The exhaustive sweep. Every timezone, every day of 2026 covered by one
     * of seven overlapping 60-day windows — so every clock change anywhere in
     * the world falls inside at least one window, and the assertion is that
     * the store's local-midnight arithmetic agrees with UTC arithmetic on all
     * of them.
     */
    const year = everyDayOf2026();
    const windows = listOf(7, (i) => runFrom(year[Math.min(i * 55, year.length - MAX_DAYS)] as string, MAX_DAYS));
    // The windows must actually cover the year, or this sweeps less than it
    // claims to.
    const covered = new Set(windows.flat());
    expect(covered.size).toBeGreaterThanOrEqual(360);

    let checked = 0;
    for (const zone of ALL_ZONES) {
      inZone(zone);
      for (const window of windows) {
        const last = window[window.length - 1] as string;
        installStorage({ [KEY]: JSON.stringify({ days: window, current: 0, longest: 0 }) });
        vi.useFakeTimers();
        vi.setSystemTime(new Date(`${last}T12:00:00`));

        const streak = readStreak(LEARNER);
        const where = `${zone} window ending ${last}`;
        // Nothing dropped by isDay, nothing reordered.
        expect(streak.days, where).toEqual(window);
        // 24 hours is not the only length of a day, and this is the number
        // that proves the clamp works.
        expect(streak.current, where).toBe(MAX_DAYS);
        expect(streak.longest, where).toBe(MAX_DAYS);
        vi.useRealTimers();
        checked += 1;
      }
    }
    expect(checked).toBe(ALL_ZONES.length * windows.length);
  });
});

describe("the named clock changes", () => {
  it("keeps a run alive across each one, counted by recordPractice", () => {
    /**
     * The same claim as the sweep above, but built the way a learner builds
     * it: one `recordPractice` per day, three days straddling the transition.
     * Named so a failure says which transition and what shape it is.
     */
    for (const { zone, day, note } of NAMED_TRANSITIONS) {
      inZone(zone);
      installStorage();
      const days = runFrom(new Date((utcDayNumber(day) - 1) * 86_400_000).toISOString().slice(0, 10), 3);
      const where = `${zone} ${day} (${note})`;

      let streak = readStreak(LEARNER);
      for (const each of days) streak = recordPractice(LEARNER, each);

      expect(streak.days, where).toEqual(days);
      expect(streak.current, where).toBe(3);
      expect(streak.longest, where).toBe(3);
      expect(practisedToday(streak, days[2] as string), where).toBe(true);
      expect(daysInLast(streak, 3, days[2] as string), where).toBe(3);
    }
  });

  it("does not credit a day twice when the clocks add an hour", () => {
    // The fall-back case a learner can actually hit: practising at 01:30,
    // the clocks going back, and practising again at 01:30 the "same" hour.
    // Both are the same calendar day, so it is one day, not two.
    inZone("America/New_York");
    installStorage();
    const first = recordPractice(LEARNER, "2026-11-01");
    const second = recordPractice(LEARNER, "2026-11-01");
    // Value-equal, not reference-equal: the second call short-circuits on
    // "already credited" and hands back what it read, which is a fresh
    // object. What matters is that it credited nothing new.
    expect(second).toEqual(first);
    expect(second.days).toEqual(["2026-11-01"]);
    expect(second.current).toBe(1);
  });

  it("credits both sides of a midnight that is 23 hours after the last one", () => {
    // Practising just before midnight and just after it is two days, and the
    // shortened day must not swallow one of them.
    inZone("America/New_York");
    installStorage();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T23:40:00"));
    recordPractice(LEARNER, localDay());
    vi.setSystemTime(new Date("2026-03-08T00:20:00"));
    const streak = recordPractice(LEARNER, localDay());
    expect(streak.days).toEqual(["2026-03-07", "2026-03-08"]);
    expect(streak.current).toBe(2);
  });
});

describe("when a streak lapses", () => {
  it("counts yesterday as live and the day before as lapsed, in every named zone", () => {
    /**
     * The kindest boundary in the product, and an off-by-one either way.
     *
     * A learner who practised last night and opens the app this morning has
     * not lost anything, and telling them their streak is zero before they
     * have had a chance to practise would be both wrong and the worst
     * possible moment to say it. One more day of silence and it has genuinely
     * lapsed.
     *
     * Swept across the DST transitions too, because the day the clocks change
     * is exactly where "one day ago" stops being 24 hours — a tolerance
     * computed from elapsed time rather than from calendar days would be
     * wrong for one day a year in half the world.
     */
    for (const { zone, day, note } of NAMED_TRANSITIONS) {
      inZone(zone);
      const days = runFrom(new Date((utcDayNumber(day) - 2) * 86_400_000).toISOString().slice(0, 10), 3);
      const last = days[days.length - 1] as string;

      for (let forwardBy = 0; forwardBy <= 4; forwardBy += 1) {
        installStorage({ [KEY]: JSON.stringify({ days, current: 0, longest: 0 }) });
        const today = new Date((utcDayNumber(last) + forwardBy) * 86_400_000)
          .toISOString()
          .slice(0, 10);
        vi.useFakeTimers();
        vi.setSystemTime(new Date(`${today}T12:00:00`));

        const streak = readStreak(LEARNER);
        const where = `${zone} ${day} (${note}), clock +${forwardBy} days`;
        // Today or yesterday keeps the run; two days of silence ends it.
        expect(streak.current, where).toBe(forwardBy <= 1 ? 3 : 0);
        // A lapse never erases the best run ever recorded.
        expect(streak.longest, where).toBe(3);
        expect(practisedToday(streak, today), where).toBe(forwardBy === 0);
        vi.useRealTimers();
      }
    }
  });

  it("counts the last seven days from today, not from the newest entry", () => {
    // The kinder figure the UI shows alongside the streak. Swept over the
    // whole window plus one, because `ago < window` is the sort of bound that
    // is wrong at exactly one value.
    inZone("Europe/Berlin");
    const days = runFrom("2026-03-25", 10);
    const streak = { days, current: 0, longest: 0 };
    for (let window = 1; window <= 12; window += 1) {
      expect(daysInLast(streak, window, "2026-04-03"), `window ${window}`).toBe(
        Math.min(window, 10),
      );
    }
    // And days after `today` are not counted, however the clock got there.
    expect(daysInLast(streak, 7, "2026-03-27")).toBe(3);
  });
});

describe("a clock that runs backwards", () => {
  it("never invents a longer streak than the days actually show", () => {
    /**
     * A device clock can be wrong, and a learner is not responsible for that.
     * The store's answer is to be generous about *lapsing* — a `today` behind
     * the newest recorded day does not zero the streak — and that generosity
     * has to be bounded: it must never produce a `current` larger than the
     * consecutive run the day list genuinely contains.
     */
    const rng = makeRng(SEED_CLOCK);
    let sawBackwards = 0;

    for (let i = 0; i < 600; i += 1) {
      inZone(pickFrom(rng, ["UTC", "America/New_York", "Europe/Berlin", "Australia/Lord_Howe", "Asia/Kolkata"]));
      const start = pickFrom(rng, everyDayOf2026());
      const days = refDays(runFrom(start, intBetween(rng, 1, 8)));
      installStorage({ [KEY]: JSON.stringify({ days, current: 0, longest: 0 }) });

      const last = days[days.length - 1] as string;
      // A `today` up to sixty days behind the newest recorded day.
      const daysBack = intBetween(rng, 0, 60);
      const today = new Date((utcDayNumber(last) - daysBack) * 86_400_000).toISOString().slice(0, 10);
      if (daysBack > 0) sawBackwards += 1;

      const streak = readStreak(LEARNER);
      const where = `seed ${SEED_CLOCK} case ${i}: days ${days.length}, clock ${daysBack} days back`;

      expect(streak.current, where).toBeLessThanOrEqual(refLongest(days));
      expect(streak.current, where).toBeLessThanOrEqual(days.length);
      expect(streak.longest, where).toBe(refLongest(days));
      // And it cannot invent a day: the list is still exactly what was stored.
      expect(streak.days, where).toEqual(days);
      // `daysInLast` counts backwards from `today`, so a clock behind the
      // history sees fewer days, never more.
      expect(daysInLast(streak, 7, today), where).toBeLessThanOrEqual(7);
      expect(daysInLast(streak, 7, today), where).toBeLessThanOrEqual(days.length);
    }

    expect(sawBackwards).toBeGreaterThan(400);
  });

  it("cannot be used to write a longest streak that was never practised", () => {
    // `readStreak` recomputes the counters rather than trusting them, so a
    // hand-edited store cannot inflate a streak. The stored `longest` is the
    // one exception, and only upwards from what the (trimmed) days show —
    // a run that has since aged out of the sixty-day list was still real.
    installStorage({ [KEY]: JSON.stringify({ days: ["2026-09-07"], current: 999, longest: 4 }) });
    const streak = readStreak(LEARNER);
    expect(streak.current).not.toBe(999);
    expect(streak.longest).toBe(4);

    installStorage({ [KEY]: JSON.stringify({ days: runFrom("2026-09-01", 5), longest: 2 }) });
    expect(readStreak(LEARNER).longest).toBe(5);
  });
});

describe("the day list, over generated histories", () => {
  it("matches the reference model for every generated history and clock", () => {
    /**
     * The general sweep: arbitrary day sets — with gaps, duplicates, days out
     * of order, invalid strings and more than the sixty the store keeps —
     * read back through the store and compared against UTC arithmetic.
     */
    const rng = makeRng(SEED_DAYS);
    const year = everyDayOf2026();
    const zones = ["UTC", "America/New_York", "Europe/Berlin", "America/Havana", "Pacific/Chatham", "Asia/Kolkata"];
    let sawGaps = 0;
    let sawTrimmed = 0;
    let sawJunk = 0;
    let lapsed = 0;
    let liveYesterday = 0;

    for (let i = 0; i < 1_200; i += 1) {
      inZone(pickFrom(rng, zones));
      const raw: string[] = [];
      let cursor = intBetween(rng, 0, year.length - 1);
      const wanted = intBetween(rng, 0, 75);
      for (let n = 0; n < wanted; n += 1) {
        const day = year[cursor % year.length];
        if (day !== undefined) raw.push(day);
        // Mostly consecutive, sometimes a gap, sometimes a repeat.
        cursor += chance(rng, 0.7) ? 1 : intBetween(rng, 0, 4);
      }
      if (wanted > 4) sawGaps += 1;
      if (wanted > MAX_DAYS) sawTrimmed += 1;
      // Junk the store has to survive: not-a-date strings and impossible dates.
      const junk = chance(rng, 0.25)
        ? [pickFrom(rng, ["", "2026-99-99", "2026-02-30", "not-a-day", "2026-1-1", "20260101"])]
        : [];
      if (junk.length > 0) sawJunk += 1;

      const stored = [...raw, ...junk];
      installStorage({ [KEY]: JSON.stringify({ days: stored, current: 7, longest: 0 }) });

      const expectedDays = refDays(raw);
      const last = expectedDays[expectedDays.length - 1];
      /**
       * The clock is not pinned to the newest recorded day. It is moved
       * forward by nought to four days, because "consecutive days ending
       * today *or yesterday*" is a boundary and asking only at offset zero
       * never reaches it — a `current` that tolerated two days of absence
       * would look identical.
       */
      const forwardBy = intBetween(rng, 0, 4);
      const today =
        last === undefined
          ? "2026-06-15"
          : new Date((utcDayNumber(last) + forwardBy) * 86_400_000).toISOString().slice(0, 10);
      if (forwardBy >= 2) lapsed += 1;
      if (forwardBy === 1) liveYesterday += 1;
      vi.useFakeTimers();
      vi.setSystemTime(new Date(`${today}T12:00:00`));

      const streak = readStreak(LEARNER);
      const where = `seed ${SEED_DAYS} case ${i} (${stored.length} stored)`;

      expect(streak.days, where).toEqual(expectedDays);
      expect(streak.days.length, where).toBeLessThanOrEqual(MAX_DAYS);
      expect(streak.current, where).toBe(refCurrent(expectedDays, today));
      expect(streak.longest, where).toBe(refLongest(expectedDays));
      // The invalid entries never reach the list, and never count.
      for (const bad of junk) expect(streak.days, where).not.toContain(bad);
      vi.useRealTimers();
    }

    // The sweep visited the shapes it is about.
    expect(sawGaps).toBeGreaterThan(500);
    expect(sawTrimmed).toBeGreaterThan(50);
    expect(sawJunk).toBeGreaterThan(200);
    expect(lapsed).toBeGreaterThan(300);
    expect(liveYesterday).toBeGreaterThan(150);
  });

  it("agrees with itself through a write and a read", () => {
    // `writeStreak` is how the server's merged union of every device's days
    // comes back, so its normalisation has to match `readStreak`'s or a sync
    // would change a learner's streak without anyone practising.
    const rng = makeRng(SEED_DAYS + 1);
    const year = everyDayOf2026();
    for (let i = 0; i < 300; i += 1) {
      inZone(pickFrom(rng, ["UTC", "America/New_York", "Australia/Lord_Howe"]));
      installStorage();
      const days = listOf(intBetween(rng, 0, 70), () => pickFrom(rng, year));
      const claimedLongest = intBetween(rng, 0, 3);
      writeStreak(LEARNER, { days, current: 0, longest: claimedLongest });

      const expectedDays = refDays(days);
      const today = expectedDays[expectedDays.length - 1] ?? "2026-06-15";
      vi.useFakeTimers();
      vi.setSystemTime(new Date(`${today}T12:00:00`));

      const back = readStreak(LEARNER);
      expect(back.days, `case ${i}`).toEqual(expectedDays);
      // A caller's claimed `longest` is honoured only upwards: a run that has
      // aged out of the sixty-day list was still practised, but a claim below
      // what the days show cannot shrink it.
      expect(back.longest, `case ${i}`).toBe(Math.max(claimedLongest, refLongest(expectedDays)));
      // Idempotent: writing back what was read changes nothing.
      writeStreak(LEARNER, back);
      expect(readStreak(LEARNER), `case ${i}`).toEqual(back);
      vi.useRealTimers();
    }
  });

  it("forgets everything on request, in any timezone", () => {
    for (const zone of ["UTC", "America/New_York", "Pacific/Chatham"]) {
      inZone(zone);
      installStorage();
      recordPractice(LEARNER, "2026-09-07");
      clearStreak(LEARNER);
      expect(readStreak(LEARNER), zone).toEqual({ days: [], current: 0, longest: 0 });
    }
  });
});
