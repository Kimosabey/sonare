/**
 * The class on a phone — Teacher board 1i.
 *
 * "What is worth a glance between lessons: who is in the room today, and the
 * one sound to spend five minutes on. Nothing that needs a desk."
 *
 * So this is not the overview made narrow. It answers two questions and stops:
 * which sound to chorus, and how many have been practising. The table, the
 * buckets and the pupil list all need a desk, and a teacher holding a phone in
 * a corridor is not at one.
 *
 * It renders beside `ClassOverview` and the two are swapped by a media query
 * rather than by a breakpoint in JavaScript — the same reasoning the
 * navigation states: a JS breakpoint has to guess before first paint and gets
 * it wrong on a rotation. Only one is in the accessibility tree at a time,
 * because `display: none` removes the other from it.
 */

import type { ClassSummary } from "../teacher/classSummary.js";

export interface ClassGlanceProps {
  className: string;
  code: string;
  summary: ClassSummary;
  /** Words the hardest sound turns up in, for the chorus line. */
  heardIn?: Readonly<Record<string, readonly string[]>>;
  today?: Date;
}

/** The weekday a teacher would name it by. */
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function ClassGlance({
  className,
  code,
  summary,
  heardIn = {},
  today = new Date(),
}: ClassGlanceProps) {
  if (!summary.reportable) {
    return (
      <section className="class-glance">
        <h2>{className}</h2>
        <p className="hint">
          Too few pupils have joined to describe the class as a group yet.
        </p>
      </section>
    );
  }

  const hardest = summary.sounds[0];
  const words = hardest === undefined ? [] : (heardIn[hardest.grapheme] ?? []).slice(0, 2);
  // The most recent day with a figure, which is what "this week" means to a
  // teacher glancing on a Thursday.
  const latest = summary.attendance[summary.attendance.length - 1];

  return (
    <section className="class-glance">
      <p className="glance-day">
        {DAYS[today.getDay()]} · {className}
      </p>

      {hardest !== undefined && (
        <div className="glance-focus">
          <h2>Before the lesson</h2>
          <p className="glance-spend">
            Spend five minutes on <span lang={code}>{hardest.grapheme}</span>
          </p>
          <p>
            Hard for {hardest.working} of {summary.joinedCount}.
            {words.length > 0 && (
              <>
                {" "}
                Chorus{" "}
                {words.map((word, index) => (
                  <span key={word}>
                    {index > 0 ? " and " : ""}
                    <span lang={code}>{word}</span>
                  </span>
                ))}{" "}
                before anyone says it alone.
              </>
            )}
          </p>
        </div>
      )}

      {latest !== undefined && (
        <div className="glance-attendance">
          <h3>Practised this week</h3>
          <p className="glance-count">
            {latest.practisedCount} of {summary.joinedCount}
          </p>
        </div>
      )}

      {/*
        Nothing else. The board's own limit — "nothing that needs a desk" — and
        a link to the rest would be an invitation to read a table on a phone
        between lessons, which is the thing this replaces.
      */}
    </section>
  );
}
