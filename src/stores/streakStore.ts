/**
 * Practice days. Attendance, never score.
 *
 * A streak is the strongest retention mechanic in language learning and the
 * easiest one to point at the wrong thing. Tied to performance it punishes the
 * accent a learner arrived with — and whether the scorer is even fair across
 * accents is the open question T19 exists to answer, so a streak that broke on
 * a low score would be enforcing a judgement nobody has validated.
 *
 * `recordPractice` therefore takes **no score, no accuracy and no pass flag**.
 * The rule is not a comment that can drift; it is the shape of the function.
 * Showing up is the whole condition.
 *
 * Per learner and *not* per language: a practice day is a fact about a person,
 * so a learner who does French on Monday and Hindi on Tuesday has practised
 * two days running, not started two streaks.
 */

/** In the key, so a bump orphans old data rather than misreading it. */
const SCHEMA_VERSION = "v1";

/**
 * Days kept.
 *
 * Enough for "four of the last seven" and a two-month calendar, bounded so a
 * learner of two years is not carrying seven hundred date strings. The
 * counters are stored separately, so trimming the list never shortens a
 * streak.
 */
const MAX_DAYS = 60;

export interface Streak {
  /** `YYYY-MM-DD` in the learner's own timezone, most recent last. */
  days: string[];
  /** Consecutive days ending today or yesterday. Zero once it has lapsed. */
  current: number;
  /** The best run ever recorded, which a lapse must not erase. */
  longest: number;
}

const EMPTY: Streak = { days: [], current: 0, longest: 0 };

function storageKey(learnerName: string | null): string {
  return `sonare.streak.${SCHEMA_VERSION}.${learnerName ?? "anonymous"}`;
}

/**
 * The learner's own calendar day, not UTC.
 *
 * This matters more than it looks. Someone practising at 23:40 and again at
 * 00:20 has practised on two days and should be credited with both; under UTC
 * a learner east of Greenwich would see one of those land on the wrong day,
 * and one west of it would see a day they practised go missing. A streak is a
 * claim about the learner's calendar, so it is computed in theirs.
 */
export function localDay(when: Date = new Date()): string {
  const year = when.getFullYear();
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** `YYYY-MM-DD`, and a real date rather than 2026-99-99. */
function isDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00`);
  return !Number.isNaN(parsed.getTime()) && localDay(parsed) === value;
}

/** Days between two `YYYY-MM-DD` strings, ignoring clocks and DST. */
function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00`).getTime();
  const b = new Date(`${to}T00:00:00`).getTime();
  return Math.round((b - a) / 86_400_000);
}

/**
 * Reads the streak, validating every field.
 *
 * The counters are recomputed from the day list rather than trusted, so a
 * hand-edited or half-written value cannot inflate a streak — and `longest` is
 * taken as the larger of the stored figure and what the days actually show,
 * because a run that has since been trimmed out of the list was still real.
 */
export function readStreak(learnerName: string | null): Streak {
  let raw: string | null;
  try {
    raw = localStorage.getItem(storageKey(learnerName));
  } catch {
    return EMPTY;
  }
  if (raw === null) return EMPTY;

  try {
    const parsed = JSON.parse(raw) as Partial<Streak>;
    const days = Array.isArray(parsed.days) ? parsed.days.filter(isDay) : [];
    const unique = [...new Set(days)].sort().slice(-MAX_DAYS);
    const storedLongest =
      typeof parsed.longest === "number" && Number.isFinite(parsed.longest) && parsed.longest >= 0
        ? Math.floor(parsed.longest)
        : 0;

    return {
      days: unique,
      current: currentRun(unique),
      longest: Math.max(storedLongest, longestRun(unique)),
    };
  } catch {
    return EMPTY;
  }
}

/**
 * Consecutive days ending today or yesterday.
 *
 * Yesterday still counts as live: a learner who practised last night and opens
 * the app this morning has not lost anything, and telling them their streak is
 * zero before they have had a chance to practise would be both wrong and the
 * worst possible moment to say it.
 */
function currentRun(days: string[], today: string = localDay()): number {
  if (days.length === 0) return 0;
  const last = days[days.length - 1];
  if (last === undefined) return 0;

  const sinceLast = daysBetween(last, today);
  if (sinceLast > 1) return 0;

  let run = 1;
  for (let i = days.length - 1; i > 0; i -= 1) {
    const later = days[i];
    const earlier = days[i - 1];
    if (later === undefined || earlier === undefined) break;
    if (daysBetween(earlier, later) !== 1) break;
    run += 1;
  }
  return run;
}

/** The longest consecutive run anywhere in the list. */
function longestRun(days: string[]): number {
  let best = 0;
  let run = 0;
  for (let i = 0; i < days.length; i += 1) {
    const current = days[i];
    const previous = i > 0 ? days[i - 1] : undefined;
    if (current === undefined) continue;
    run = previous !== undefined && daysBetween(previous, current) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}

/**
 * Records that the learner practised today.
 *
 * **Takes no score.** Not an accuracy, not a pass flag, not a count of
 * activities — nothing that could later be used to withhold a day. Idempotent,
 * so calling it after every take in a session credits one day, and a learner
 * who does ten activities is not ten days ahead of one who did one.
 */
export function recordPractice(learnerName: string | null, today: string = localDay()): Streak {
  const existing = readStreak(learnerName);
  if (existing.days.includes(today)) return existing;

  const days = [...existing.days, today].sort().slice(-MAX_DAYS);
  const next: Streak = {
    days,
    current: currentRun(days, today),
    longest: Math.max(existing.longest, longestRun(days)),
  };

  try {
    localStorage.setItem(storageKey(learnerName), JSON.stringify(next));
  } catch {
    // Quota or private browsing. The session is unaffected; only the streak
    // fails to carry, which is the right thing to lose.
  }

  return next;
}

/** Whether today is already credited, so the UI can say "done today". */
export function practisedToday(streak: Streak, today: string = localDay()): boolean {
  return streak.days.includes(today);
}

/**
 * Days practised in the last `window` days, today included.
 *
 * Offered alongside the streak because it is the kinder and often truer
 * figure: four of the last seven is a good week, and a learner who missed
 * Wednesday has not failed. A raw streak alone turns one busy day into a
 * reason to stop.
 */
export function daysInLast(streak: Streak, window = 7, today: string = localDay()): number {
  return streak.days.filter((day) => {
    const ago = daysBetween(day, today);
    return ago >= 0 && ago < window;
  }).length;
}

/** Forgets a learner's practice history. */
export function clearStreak(learnerName: string | null): void {
  try {
    localStorage.removeItem(storageKey(learnerName));
  } catch {
    // Best effort.
  }
}
