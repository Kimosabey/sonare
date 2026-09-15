/**
 * The shape of today's sitting, stated before it starts — board 1a.
 *
 * "Four activities, about five minutes", and then what those four *are*: new
 * content from the lesson plus the sounds that have come round on the review
 * ladder. That blend is what makes this a course rather than a list of
 * exercises, and a learner who cannot see it has no way to tell the difference.
 *
 * ## Why it is stated rather than summarised
 *
 * A learner deciding whether they have time for this needs a real answer, and
 * "continue" gives them none. Naming the lesson, the count and the due sounds
 * costs four lines and turns an open-ended commitment into a bounded one —
 * which is the difference between opening the app on a bus and not.
 *
 * `composeSession` already computes all of it, and has since C3. Nothing
 * rendered it until now.
 *
 * ## The estimate
 *
 * Deliberately vague — "about five minutes" — because it is genuinely an
 * estimate: up to three takes per activity, of up to fifteen seconds each,
 * plus scoring and however long the learner spends reading. A figure to the
 * minute would be precision the product cannot back, and a learner who found
 * it wrong twice would stop believing the rest of the screen.
 */

import { Link } from "react-router-dom";
import type { ComposedSession } from "../learning/composeSession.js";

/**
 * Roughly how long one activity takes, in minutes.
 *
 * From the shipped ceilings rather than a guess: three takes of up to fifteen
 * seconds is 45 seconds of speaking, plus scoring and reading time. It rounds
 * to "about five minutes" for a four-activity lesson, which is what the board
 * shows.
 */
const MINUTES_PER_ACTIVITY = 1.25;

function estimateMinutes(count: number): number {
  return Math.max(1, Math.round(count * MINUTES_PER_ACTIVITY));
}

/** "7 days since", from a review's own due date. */
function sinceLabel(due: string, today: string): string | null {
  const days = Math.round(
    (new Date(`${today}T00:00:00Z`).getTime() - new Date(`${due}T00:00:00Z`).getTime()) /
      86_400_000,
  );
  if (Number.isNaN(days) || days < 0) return null;
  return days === 0 ? "due today" : `${String(days)} ${days === 1 ? "day" : "days"} since`;
}

export interface TodaysSittingProps {
  session: ComposedSession;
  /** True when this device cannot record, so the listening route leads. */
  listeningOnly?: boolean;
}

export function TodaysSitting({ session, listeningOnly = false }: TodaysSittingProps) {
  const count = session.activities.length;
  if (count === 0 && session.reviews.length === 0) return null;

  return (
    <section className="sitting enter-2" aria-labelledby="sitting-heading">
      <h3 id="sitting-heading" className="today-heading">
        Today&rsquo;s sitting
      </h3>

      {session.lesson !== null && (
        <p className="what">
          <b>{session.lesson.unitTitle}</b> · {session.lesson.title}
        </p>
      )}

      <p className="hint">
        {count} {count === 1 ? "activity" : "activities"}, about {estimateMinutes(count)} minutes.
      </p>

      <ul className="sitting-items">
        {count > 0 && (
          <li>
            <span className="sitting-tag tag-new">NEW</span>
            <span>
              {session.lesson === null
                ? `${String(count)} phrases to say`
                : session.lesson.outcome}
            </span>
          </li>
        )}
        {/*
          The due sounds, named individually rather than counted. "Three sounds
          due" is a number; "the r in voudrais, 7 days since" is the actual
          reason to sit down, and it is the half only this product can offer.
        */}
        {session.reviews.map((review) => {
          const since = sinceLabel(review.due, session.day);
          return (
            <li key={review.grapheme}>
              <span className="sitting-tag tag-due">DUE</span>
              <span>
                <b lang={session.code}>{review.grapheme}</b>
                {since !== null && <span className="hint"> — {since}</span>}
              </span>
            </li>
          );
        })}
      </ul>

      <div className="row">
        <Link className="enter-cta" to={`/${session.slug}`}>
          Start the sitting
        </Link>
        {/*
          Offered on every arrival, not only when the microphone is missing.
          A learner on a quiet carriage has the same problem as one with a dead
          microphone, and having to discover the option by failing first is the
          thing this screen exists to avoid.
        */}
        <Link className="ghost" to={`/${session.slug}`}>
          {listeningOnly ? "Do the listening" : "Just the listening (no microphone)"}
        </Link>
      </div>
    </section>
  );
}
