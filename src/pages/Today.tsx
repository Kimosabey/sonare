/**
 * The new front door: one tap to the right activity.
 *
 * The language picker was the front door, which made every visit start with a
 * question the learner had already answered. A returning learner wants to
 * carry on, so that is what this screen offers first — and everything on it is
 * derived from data that already existed and was being thrown away.
 *
 * Four things, in the order they matter to somebody opening the app:
 *
 * The resume card, because it is the tap they came to make.
 *
 * The streak, which counts **attendance and never score** (streakStore.ts).
 * Shown beside "days in the last seven" because that second figure is the
 * kinder and often truer one: four of seven is a good week, and a learner who
 * missed Wednesday has not failed. A raw streak alone turns one busy day into
 * a reason to stop.
 *
 * The weakest sound with its trend, which is the one claim no competitor
 * makes. It is deliberately the only place a number about *pronunciation*
 * appears on this screen, and it is labelled as a practice figure rather than
 * a score.
 *
 * The other languages, so switching is a tap rather than a trip back through
 * a picker.
 *
 * Nothing here fabricates a comparison. `trendFor` returns a null `before`
 * until there is history either side of the window, and a first week must read
 * as "no history yet" rather than "no change" — telling a learner nothing
 * changed on their first Tuesday is telling them something false.
 *
 * ── The lapsed learner ──────────────────────────────────────────────────────
 *
 * A persona audit found this screen greeting somebody who left yesterday and
 * somebody who left in July with the same word — "Carry on" — over a streak of
 * zero sitting next to a best run of nine. That arrangement reads as a loss
 * report, and it is the last thing a learner needs at the one moment they have
 * chosen to come back.
 *
 * So the greeting names the gap, and then says what survived it. Both halves
 * come from data already on disk: `lastPractisedAt` for the gap, and the
 * persisted per-sound history for what held up. Nothing is recomputed from raw
 * attempts and nothing new is stored.
 *
 * What this deliberately is *not*: a streak freeze, a repair token, or any
 * make-up mechanic. Those are consolations for a number this product has
 * decided not to weaponise — the streak counts attendance, takes no score, and
 * `recordPractice`'s signature is what keeps it that way. The fix for a zero
 * that reads as a punishment is honest copy, not a currency to buy it back.
 */

import { Link } from "react-router-dom";
import { useLearnerName } from "../hooks/useLearnerName.js";
import { allProgress, nextUp } from "../learning/nextUp.js";
import { readStreak, daysInLast, practisedToday } from "../stores/streakStore.js";
import { readSkills, weakestSkills, type SkillTrend } from "../stores/skillStore.js";

/** A whole number for display. Practice figures are not shown to a decimal. */
function round(value: number): number {
  return Math.round(value);
}

/**
 * Sounds named as having held up. Two, because they share a line with the
 * greeting on a phone and a list of five stops being reassurance and starts
 * being a report.
 */
const HELD_SOUNDS = 2;

/**
 * The gap at which the streak on this screen reads zero.
 *
 * Not an arbitrary threshold. `currentRun` keeps yesterday alive on purpose, so
 * two days is exactly the point at which the number becomes a 0 beside a best
 * run — which is the moment the copy has to stop sounding like a scold.
 */
const LAPSED_AFTER_DAYS = 2;

interface Away {
  /** Whole days since the last attempt, in the learner's own calendar. */
  days: number;
  /** The gap in words, e.g. "3 weeks away". */
  label: string;
  /** True once the streak has gone to zero and the copy has to do more work. */
  lapsed: boolean;
}

/**
 * Days since an ISO instant, counted in the learner's own calendar.
 *
 * Local midnight on both sides, for exactly the reason `streakStore.localDay`
 * exists: practice is credited to the learner's calendar day, so a gap
 * measured in UTC would disagree with the streak it sits next to. Rounded, so
 * the hour gained or lost at a DST boundary cannot turn one day into two.
 */
function daysSince(iso: string, now: Date): number | null {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  const from = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime();
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  // Clamped at zero: a device clock nudged backwards, or a timestamp written by
  // a device an hour ahead, must not produce "-1 days away".
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

/**
 * The gap in words, in bands that stay truthful as they coarsen.
 *
 * Every band floors rather than rounds up, so the figure never overstates the
 * absence — "3 weeks away" on day 27 is understating it, which is the safe
 * direction to be wrong in when the sentence is addressed to somebody who has
 * just come back.
 */
function awayLabel(days: number): string {
  if (days === 1) return "Back the next day";
  if (days < 7) return `${days} days away`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return weeks === 1 ? "A week away" : `${weeks} weeks away`;
  }
  const months = Math.floor(days / 30);
  return months === 1 ? "A month away" : `${months} months away`;
}

/**
 * How long the learner has been gone, or null when there is nothing to say.
 *
 * Null covers two different silences: they have practised today already, and
 * they have never practised at all. `lastPractisedAt === null` is the only
 * honest test for the second — `allProgress` returns every language the app
 * ships, including ones nobody has opened, so an "is the list empty" branch
 * would be unreachable code that looks like a guard.
 */
function awayFor(lastPractisedAt: string | null, now: Date): Away | null {
  if (lastPractisedAt === null) return null;
  const days = daysSince(lastPractisedAt, now);
  if (days === null || days === 0) return null;
  return { days, label: awayLabel(days), lapsed: days >= LAPSED_AFTER_DAYS };
}

/**
 * The greeting's second line: the gap, and then what came through it.
 *
 * The order matters. Naming the gap first is what stops this reading as a
 * product that did not notice — and it has to be the *true* gap, because a
 * learner who knows they were away three weeks will not believe the sentence
 * after it if the first half is wrong. What follows is the reassurance, and it
 * is only ever a claim about data that exists: named sounds when there are
 * some, and otherwise nothing more specific than the truth that the record
 * itself is still there.
 */
function ReturnNote({ away, held, code }: { away: Away; held: SkillTrend[]; code: string }) {
  return (
    <p className="advice enter-2">
      <b>{away.label}</b>
      {!away.lapsed ? (
        // One day is not an absence, and treating it as one would invent a
        // problem to be gracious about.
        " — right where you left off."
      ) : held.length === 0 ? (
        // No sound has enough history to vouch for yet, so the reassurance
        // stays general rather than naming one bad take as an achievement.
        " — nothing you built has gone anywhere. Your record is still here."
      ) : (
        <>
          {" — your best sounds are still here: "}
          {held.map((trend, index) => (
            <span key={trend.grapheme}>
              {index > 0 ? " · " : ""}
              {/* `lang` so a screen reader says the syllable in the language
                  it belongs to rather than in the page's (WCAG 3.1.2). */}
              <b lang={code}>{trend.grapheme}</b> at {round(trend.now)}
            </span>
          ))}
          {/* Dated on purpose. These are means of samples taken before the gap,
              and presenting them in the present tense would be claiming a
              measurement nobody has taken since.
              Parenthesised rather than separated by another "·", which would
              read as one more sound in the list. */}
          <span className="hint"> (measured before you left)</span>
        </>
      )}
    </p>
  );
}

export function Today() {
  const [learnerName] = useLearnerName();

  /**
   * Read once per render rather than held in state. Every source here is
   * synchronous localStorage, and this screen is the thing a learner lands on
   * after finishing an activity — so reading on render is what makes the
   * figures current, where cached state would show them yesterday's streak.
   */
  const resume = nextUp(learnerName);
  const languages = allProgress(learnerName);
  const streak = readStreak(learnerName);
  const doneToday = practisedToday(streak);
  const week = daysInLast(streak, 7);

  // A learner who has never practised gets the picker, not an empty dashboard
  // with four zeroes on it. `nextUp` returns null exactly when no language has
  // a `lastPractisedAt`, which is the real first-visit signal.
  if (resume === null) {
    return (
      <section>
        <h2 className="enter-1">{learnerName === null ? "Welcome" : `Welcome, ${learnerName}`}</h2>
        <p className="what enter-2">Pick a language and say your first phrase.</p>
        <p className="enter-cta">
          <Link className="lang-card" to="/languages">
            Choose a language
          </Link>
        </p>
      </section>
    );
  }

  /**
   * The gap, measured from the most recently practised language of all of them.
   * `allProgress` returns them most-recent-first, so that is the front of the
   * list.
   *
   * Deliberately not `resume.lastPractisedAt`: `nextUp` prefers a language that
   * is unfinished, so a learner who finished French yesterday and left Hindi
   * half-done three weeks ago is offered Hindi — and greeting them with "3
   * weeks away" when they were here yesterday is the same failure as the one
   * this replaces, pointing the other way.
   */
  const away = awayFor(languages[0]?.lastPractisedAt ?? null, new Date());

  /**
   * Every sound, once. The same already-sorted list answers both questions this
   * screen asks of it — the weakest is the front of it and the sounds that held
   * up are the back — so the ordering stays in the store rather than being done
   * twice here.
   */
  const trends = weakestSkills(readSkills(resume.slug, learnerName), Number.MAX_SAFE_INTEGER);
  const weakest = trends[0];

  /**
   * The strongest sounds, read off the back of that list. The weakest is
   * excluded because the line further down already names it as the thing being
   * worked on, and a screen that calls one syllable both the weakest and the
   * best has told the learner nothing.
   */
  const held = trends
    .slice(-HELD_SOUNDS)
    .reverse()
    .filter((trend) => trend !== weakest);

  return (
    <section>
      <h2 className="enter-1">
        {/* The gap changes the greeting, not just the line below it. "Welcome
            back" is right for somebody who was here yesterday and slightly
            wrong for somebody who was here in July. */}
        {away?.lapsed === true
          ? learnerName === null
            ? "Good to see you again"
            : `Good to see you again, ${learnerName}`
          : learnerName === null
            ? "Welcome back"
            : `Welcome back, ${learnerName}`}
      </h2>

      {away !== null && <ReturnNote away={away} held={held} code={resume.code} />}

      {/* The tap they came to make. First, and visually the largest thing. */}
      <Link className="lang-card resume-card enter-2" to={`/${resume.slug}`}>
        <span className="lang-card-label">
          {/* "Carry on" is what somebody mid-flow is doing. Somebody who has
              been away is picking it back up, which is a different sentence and
              was the audit's actual complaint about this line. */}
          {resume.complete ? "Practise again" : away?.lapsed === true ? "Pick up again" : "Carry on"}
          {" · "}
          {resume.label}
        </span>
        <span className="lang-card-count">
          {/* `lang` so a screen reader pronounces the phrase in its own
              language rather than in the page's (WCAG 3.1.2). */}
          <span lang={resume.code}>{resume.activity.title}</span>
          {" — "}
          {resume.position} of {resume.total}
        </span>
      </Link>

      <dl className="today-stats enter-2">
        <div>
          <dt>Streak</dt>
          <dd>
            {streak.current}
            <small>
              {streak.current === 1 ? "day" : "days"}
              {/*
               * A bare 0 next to a best run of nine reads as a loss report.
               * "Ready to start again" is the same fact stated forwards, and it
               * is not a make-up mechanic: nothing is credited, restored or
               * sold back. Practising is still the only thing that counts a day.
               *
               * The two clauses cannot both apply — `currentRun` returns at
               * least 1 once today is in the list — so this is a choice, not
               * two appended phrases.
               */}
              {doneToday
                ? " · practised today"
                : streak.current === 0
                  ? " · ready to start again"
                  : ""}
            </small>
          </dd>
        </div>
        <div>
          <dt>This week</dt>
          <dd>
            {week}
            <small>of 7 days</small>
          </dd>
        </div>
        <div>
          <dt>Best run</dt>
          <dd>
            {streak.longest}
            <small>{streak.longest === 1 ? "day" : "days"}</small>
          </dd>
        </div>
      </dl>

      {weakest !== undefined && (
        <p className="advice enter-2">
          Working on <b lang={resume.code}>{weakest.grapheme}</b> — now at {round(weakest.now)}
          {weakest.before === null ? (
            /**
             * The honest answer for a first week. "No change" would be
             * inventing a comparison against history that does not exist, and
             * a learner reading it on their first Tuesday has been told
             * something false.
             */
            <span className="dim"> · not enough history to show a trend yet</span>
          ) : (
            <span className={weakest.now >= weakest.before ? "gain" : "dim"}>
              {" · "}
              {weakest.now >= weakest.before ? "up" : "down"} from {round(weakest.before)}
            </span>
          )}
        </p>
      )}

      {languages.length > 1 && (
        <>
          <h3 className="today-heading">Other languages</h3>
          <div className="lang-grid">
            {languages
              .filter((set) => set.slug !== resume.slug)
              .map((set) => (
                <Link key={set.slug} className="lang-card" to={`/${set.slug}`}>
                  <span className="lang-card-label">{set.label}</span>
                  <span className="lang-card-count">
                    {set.lastPractisedAt === null
                      ? `${set.total} activities`
                      : `${set.passed} of ${set.total} passed`}
                  </span>
                </Link>
              ))}
          </div>
        </>
      )}
    </section>
  );
}
