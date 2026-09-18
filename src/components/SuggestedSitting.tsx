/**
 * What a teacher suggested, on the learner's Today screen — the pupil half of
 * board 1f.
 *
 * The board promises this "is a suggestion on their Today screen, not a lock".
 * So this renders a prompt and a link, and deliberately nothing else: no
 * countdown, no "due", no badge, no position above the sitting Today had
 * already composed. A learner who ignores it is not behind on anything.
 *
 * The teacher's phrase for when is shown as a phrase. There is no date here to
 * count down from, because the server does not store one — and a screen that
 * turned "this week" into "3 days left" would invent the deadline the whole
 * design refuses.
 *
 * It names who asked. A prompt from nowhere is an instruction; a prompt from
 * Mr Okonjo is a person asking, which is what a pupil can weigh.
 */

import { Link } from "react-router-dom";

/** The teacher's own words, mapped for a pupil reading them. */
const WHEN: Record<string, string> = {
  "this-week": "this week",
  "before-next-lesson": "before your next lesson",
  "no-particular-time": "whenever you like",
};

export interface SuggestedSittingProps {
  className: string;
  teacherName: string;
  slug: string;
  /** The lesson's own title, when the client could resolve it. */
  lessonTitle?: string | null;
  /** One of the three windows the teacher chose. */
  window: string;
}

export function SuggestedSitting({
  className,
  teacherName,
  slug,
  lessonTitle = null,
  window,
}: SuggestedSittingProps) {
  const when = WHEN[window];

  return (
    <div className="suggested-sitting">
      <h3 className="today-heading">A suggestion from {teacherName}</h3>
      <p>
        {lessonTitle === null ? "A sitting" : lessonTitle}, for {className}
        {/*
          Only when the window is one this build knows. An unrecognised value
          from a newer writer is dropped rather than printed raw — "for
          next-tuesday" reads as a date, which is the one thing this must not
          become.
        */}
        {when === undefined ? "" : ` — ${when}`}.
      </p>
      <p className="row">
        <Link to={`/${slug}`} className="ghost enter-cta">
          Start it
        </Link>
      </p>
      <p className="hint">
        A suggestion, not a deadline. Do it late, do part of it, or skip it — nothing here is
        marked, and nobody is told how it went.
      </p>
    </div>
  );
}
