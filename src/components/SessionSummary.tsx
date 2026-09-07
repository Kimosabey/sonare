/**
 * What this session was worth, beyond the scores in the report beside it.
 *
 * `ActivityReport` covers the session: which activities passed, the attempt
 * sequence, the weakest syllables. It says nothing about the learner across
 * sessions, because until now there was nothing to say — the streak was never
 * recorded and the sound history never persisted.
 *
 * So this is the part that only makes sense now: the practice day just
 * credited, and which sounds have actually improved. Those are the two things
 * that make finishing feel like progress rather than like an exam ending.
 *
 * Lives here rather than inside `ActivityReport` because that component sits
 * in `src/speech/`, where R11 forbids reading browser-persistent storage —
 * and everything here comes from exactly that. Rendering it as a sibling
 * keeps the capture layer's rule intact instead of arguing with it.
 */

import { Link } from "react-router-dom";
import { readStreak, daysInLast, practisedToday, type Streak } from "../stores/streakStore.js";
import { readSkills, weakestSkills, type SkillTrend } from "../stores/skillStore.js";

export interface SessionSummaryProps {
  slug: string;
  learnerName: string | null;
}

/**
 * Sounds that measurably improved, best improvement first.
 *
 * Only where there is history either side of the window — `trendFor` returns a
 * null `before` until then, and a first session must not be reported as an
 * improvement over nothing. That would be the same fabricated comparison as
 * "no change", pointed the flattering way.
 */
function improved(trends: SkillTrend[]): Array<SkillTrend & { before: number }> {
  return trends
    .filter((t): t is SkillTrend & { before: number } => t.before !== null && t.now > t.before)
    .sort((a, b) => b.now - b.before - (a.now - a.before));
}

function round(value: number): number {
  return Math.round(value);
}

/** The streak line, phrased for what actually happened. */
function streakLine(streak: Streak, week: number): string {
  if (streak.current === 0) return "Practice day recorded.";
  if (streak.current === 1) return "Day one. Come back tomorrow to make it two.";
  return `${streak.current} days in a row · ${week} of the last 7.`;
}

export function SessionSummary({ slug, learnerName }: SessionSummaryProps) {
  const streak = readStreak(learnerName);
  const credited = practisedToday(streak);
  const week = daysInLast(streak, 7);

  /**
   * Read across every syllable rather than just the weakest three, because an
   * improvement is worth showing wherever it happened — and a sound that
   * improved out of the bottom three is exactly the one a learner most wants
   * to hear about.
   */
  const store = readSkills(slug, learnerName);
  const gains = improved(weakestSkills(store, Number.MAX_SAFE_INTEGER)).slice(0, 3);

  return (
    <section className="session-summary">
      <h2>Today&rsquo;s practice</h2>

      {/* Only claimed when it is true. A learner whose day could not be
          recorded — storage blocked, private browsing — must not be told it
          was. */}
      {credited && (
        <p className="what session-streak">
          <b>{streakLine(streak, week)}</b>
        </p>
      )}

      {gains.length > 0 ? (
        <>
          <p className="what">Sounds you have improved:</p>
          <ul className="session-gains">
            {gains.map((trend) => (
              <li key={trend.grapheme}>
                <b>{trend.grapheme}</b> — {round(trend.before)} → {round(trend.now)}
              </li>
            ))}
          </ul>
        </>
      ) : (
        /**
         * The honest empty state. Saying "no improvement yet" would be a
         * verdict on the session; saying there is not enough history is a
         * statement about the data, which is what is actually true after one
         * or two sessions.
         */
        <p className="hint">
          Practise these phrases again over the next few days and this will show which sounds are
          improving.
        </p>
      )}

      <p className="row">
        <Link to="/">
          <button type="button">Back to today</button>
        </Link>
      </p>
    </section>
  );
}
