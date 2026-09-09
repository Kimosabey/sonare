/**
 * A learner's own record, over weeks rather than within a session.
 *
 * This is the screen the whole persistence effort was for. Every figure on it
 * comes from data the app used to throw away when the tab closed: syllable
 * accuracies keyed by written form, and the days practice happened.
 *
 * Three things, and the order is deliberate — sounds first, because "‑ent is
 * at 61, up from 48" is the claim no competitor makes and the reason a learner
 * would open this at all. The calendar second, because it answers "have I been
 * showing up" without any judgement attached. Completion last, because it is
 * the least interesting thing about pronunciation and the most likely to be
 * mistaken for the point.
 *
 * Nothing here fabricates a comparison. `trendFor` returns a null `before`
 * until there is history either side of the window, and that renders as
 * "not enough history yet" — never as "no change", which would be a claim
 * about data that does not exist.
 */

import { Link, useParams } from "react-router-dom";
import { resolveLanguage } from "../content/resolve.js";
import { useLearnerName } from "../hooks/useLearnerName.js";
import { allProgress } from "../learning/nextUp.js";
import { readSkills, weakestSkills, type SkillTrend } from "../stores/skillStore.js";
import { readStreak, localDay, type Streak } from "../stores/streakStore.js";

/** Weeks of calendar shown. Eight is two months, which is what the store keeps. */
const WEEKS = 8;

function round(value: number): number {
  return Math.round(value);
}

/**
 * The last `WEEKS` weeks of days, oldest first, in rows of seven.
 *
 * Built from the learner's **local** day, matching how practice is recorded —
 * a calendar computed in UTC would put a late-night session on the wrong
 * square for half the world, which is precisely the bug the store already
 * avoids.
 */
function calendarRows(streak: Streak, today: Date): Array<Array<{ day: string; practised: boolean }>> {
  const practised = new Set(streak.days);
  const days: Array<{ day: string; practised: boolean }> = [];

  // Ends today, so the most recent square is the one the learner just filled.
  for (let back = WEEKS * 7 - 1; back >= 0; back -= 1) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
    const day = localDay(date);
    days.push({ day, practised: practised.has(day) });
  }

  const rows: Array<Array<{ day: string; practised: boolean }>> = [];
  for (let i = 0; i < days.length; i += 7) rows.push(days.slice(i, i + 7));
  return rows;
}

/** A sound's trend, or the honest absence of one. */
/**
 * `code` so the syllable is announced in the language it belongs to.
 *
 * Today.tsx already tags the identical string; these two did not. For French
 * or German that means a screen reader applies English phonology to a foreign
 * syllable, which is WCAG 3.1.2 — but for Hindi it is worse than wrong: an
 * untagged Devanagari grapheme in an English voice is *skipped*, so a learner
 * on a screen reader is read a row with a number and no sound in it.
 */
function TrendRow({ trend, code }: { trend: SkillTrend; code: string }) {
  const rising = trend.before !== null && trend.now > trend.before;
  const falling = trend.before !== null && trend.now < trend.before;

  return (
    <tr>
      <td>
        <b lang={code}>{trend.grapheme}</b>
      </td>
      <td className="num">{round(trend.now)}</td>
      <td className="num">
        {trend.before === null ? (
          <span className="dim">—</span>
        ) : (
          <span className={rising ? "gain" : falling ? "dim" : undefined}>
            <span className="trend-arrow" aria-hidden="true">
              {rising ? "↑" : falling ? "↓" : "→"}
            </span>{" "}
            {round(trend.before)}
          </span>
        )}
      </td>
      <td className="num">{trend.samples}</td>
    </tr>
  );
}

export function Progress() {
  const { slug } = useParams<{ slug: string }>();
  const [learnerName] = useLearnerName();
  const language = resolveLanguage(slug);

  if (language === undefined) {
    return (
      <section>
        <h2>Language not found</h2>
        <p className="what">That&rsquo;s not one of the available languages.</p>
        <p className="row">
          <Link to="/">
            <button type="button">Back to today</button>
          </Link>
        </p>
      </section>
    );
  }

  const streak = readStreak(learnerName);
  /**
   * Every sound, not the weakest three. This is the screen where a learner
   * looks for the one they have fixed, and a list capped at the worst three
   * hides exactly that.
   */
  const trends = weakestSkills(readSkills(language.slug, learnerName), Number.MAX_SAFE_INTEGER);
  const sets = allProgress(learnerName);
  const set = sets.find((s) => s.slug === language.slug);
  const rows = calendarRows(streak, new Date());

  return (
    <section>
      <h2>{language.label} progress</h2>

      <h3 className="today-heading">Your sounds</h3>
      {trends.length === 0 ? (
        <p className="hint">
          Nothing measured yet. Practise a few phrases and each syllable you say will start
          building a history here.
        </p>
      ) : (
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th scope="col">Syllable</th>
                <th scope="col">Now</th>
                <th scope="col">Before</th>
                <th scope="col">Takes</th>
              </tr>
            </thead>
            <tbody>
              {trends.map((trend) => (
                <TrendRow key={trend.grapheme} trend={trend} code={language.code} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {trends.some((t) => t.before === null) && (
        /**
         * Explained once, below the table, rather than repeated in every row.
         * A dash with no explanation reads as a bug; "no change" would read as
         * a measurement that was never taken.
         */
        <p className="hint">
          A dash means there is not enough history to compare against yet, not that nothing
          changed.
        </p>
      )}

      <h3 className="today-heading">Practice days</h3>
      <p className="what">
        {streak.current > 0
          ? `${streak.current} in a row · best ${streak.longest}`
          : `Best run: ${streak.longest}`}
      </p>
      {/* A table, because it is a grid of dates with meaning in both axes —
          and every square carries its own date so a screen reader is not left
          reading an unlabelled wall of cells. */}
      <div className="calendar" role="table" aria-label={`Practice over the last ${WEEKS} weeks`}>
        {rows.map((week) => (
          <div key={week[0]?.day ?? ""} role="row" className="calendar-week">
            {week.map((cell) => (
              <span
                key={cell.day}
                role="cell"
                className={`calendar-day${cell.practised ? " calendar-day-on" : ""}`}
                aria-label={`${cell.day}: ${cell.practised ? "practised" : "no practice"}`}
              />
            ))}
          </div>
        ))}
      </div>

      <h3 className="today-heading">Activities</h3>
      <p className="what">
        {/* `lastPractisedAt`, not a missing entry: allProgress returns every
            language, including ones never opened, so `undefined` here would
            never happen and the friendlier copy would be unreachable. "0 of 10
            passed" reads as a failure on a screen nobody has used yet. */}
        {set === undefined || set.lastPractisedAt === null
          ? `${language.activities.length} to try`
          : `${set.passed} of ${set.total} passed`}
      </p>

      <p className="row">
        <Link to={`/${language.slug}`}>
          <button type="button">Practise {language.label}</button>
        </Link>
        <Link to="/">
          <button type="button" className="ghost">
            Back to today
          </button>
        </Link>
      </p>
    </section>
  );
}
