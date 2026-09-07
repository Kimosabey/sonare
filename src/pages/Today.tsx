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
 */

import { Link } from "react-router-dom";
import { useLearnerName } from "../hooks/useLearnerName.js";
import { allProgress, nextUp } from "../learning/nextUp.js";
import { readStreak, daysInLast, practisedToday } from "../stores/streakStore.js";
import { readSkills, weakestSkills } from "../stores/skillStore.js";

/** A whole number for display. Practice figures are not shown to a decimal. */
function round(value: number): number {
  return Math.round(value);
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
  // with four zeroes on it.
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

  // Read after the early return, so the type is a trend or nothing rather
  // than a union with an empty array standing in for "no language".
  const weakest = weakestSkills(readSkills(resume.slug, learnerName), 1)[0];

  return (
    <section>
      <h2 className="enter-1">{learnerName === null ? "Welcome back" : `Welcome back, ${learnerName}`}</h2>

      {/* The tap they came to make. First, and visually the largest thing. */}
      <Link className="lang-card resume-card enter-2" to={`/${resume.slug}`}>
        <span className="lang-card-label">
          {resume.complete ? "Practise again" : "Carry on"} · {resume.label}
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
              {doneToday ? " · practised today" : ""}
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
