/**
 * What a teacher opens — Teacher board 1d.
 *
 * Sound difficulty leads, because the board is explicit that it is "the only
 * thing here that changes what happens in the next lesson". Attendance is a
 * count and a strip, never a column beside a score, because there is no score
 * to put a column beside.
 *
 * Three absences are the design rather than omissions, and each one is a thing
 * a reader will look for:
 *
 * **No sort control.** The board: "Rows are ordered by that count and the
 * order is fixed … because the only other thing to sort by does not exist
 * here." A sort control implies a second key, and offering one over a single
 * column teaches that the other column is coming.
 *
 * **No pupil column, and no route to one.** Nothing here is clickable through
 * to a person. The summary this renders does not contain a pupil identifier at
 * all (`classSummary.ts`), so there is no drill-through to build even by
 * mistake.
 *
 * **No total for the pupils who have not joined.** Their count is stated and
 * that is all — the board: "Nothing about them appears here, including the
 * fact that they have or have not practised."
 */

import type { ClassSummary, SoundDifficulty } from "../teacher/classSummary.js";

export interface ClassOverviewProps {
  className: string;
  /** BCP-47 code, so graphemes and example words carry their language. */
  code: string;
  summary: ClassSummary;
  /** Pupils the teacher expects, when they have said — for "28 joined of 31". */
  expectedCount?: number | null;
  /** Words each sound is heard in, from the content rather than from pupils. */
  heardIn?: Readonly<Record<string, readonly string[]>>;
  /** Opens the sound detail. Absent means the rows are not links. */
  onOpenSound?: (grapheme: string) => void;
}

/** The days the strip draws, starting Monday as the board does. */
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

function hardest(sounds: readonly SoundDifficulty[]): SoundDifficulty | null {
  // Already ordered hardest-first by the summary, so this is the head rather
  // than a second opinion about the ordering.
  return sounds[0] ?? null;
}

export function ClassOverview({
  className,
  code,
  summary,
  expectedCount = null,
  heardIn = {},
  onOpenSound,
}: ClassOverviewProps) {
  if (!summary.reportable) {
    return (
      <section className="class-overview">
        <h2>{className}</h2>
        <p className="what">
          This class is too small to describe as a group. With {summary.joinedCount}{" "}
          {summary.joinedCount === 1 ? "pupil" : "pupils"} joined, a count of who is working on a
          sound would be a statement about the individuals in it, so no counts are shown.
        </p>
        <p className="hint">
          Group difficulty appears once five pupils have joined. Nothing is being withheld from
          you that is being shown to anyone else.
        </p>
      </section>
    );
  }

  const notJoined = expectedCount === null ? null : Math.max(0, expectedCount - summary.joinedCount);
  const worth = hardest(summary.sounds);
  const thisWeek = summary.attendance.slice(-7);

  return (
    <section className="class-overview">
      <h2>
        {className} ·{" "}
        {expectedCount === null
          ? `${summary.joinedCount} joined`
          : `${summary.joinedCount} joined of ${expectedCount}`}
      </h2>

      <h3>What the class finds hard</h3>
      <div className="table-scroll">
        <table className="class-sounds">
          <thead>
            <tr>
              <th scope="col">Sound</th>
              <th scope="col">Heard in</th>
              <th scope="col">How much of the class is still working on it</th>
              <th scope="col">Takes</th>
            </tr>
          </thead>
          <tbody>
            {summary.sounds.map((sound) => (
              <tr key={sound.grapheme}>
                <th scope="row" lang={code}>
                  {onOpenSound === undefined ? (
                    sound.grapheme
                  ) : (
                    <button
                      type="button"
                      className="ghost class-sound-open"
                      onClick={() => onOpenSound(sound.grapheme)}
                    >
                      <span lang={code}>{sound.grapheme}</span>
                    </button>
                  )}
                </th>
                <td lang={code}>{(heardIn[sound.grapheme] ?? []).join(" · ")}</td>
                {/* A count of pupils, never an average — so the figure cannot be
                    turned back into anybody's number. */}
                <td>
                  {sound.working} of {summary.joinedCount}
                </td>
                <td>{sound.takes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">
        A count of pupils still working on a sound, not an average of their scores. Rows are
        ordered by that count and the order is fixed.
      </p>

      <h3>Turning up</h3>
      <p className="class-attendance-count">
        {thisWeek.length === 0 ? 0 : Math.max(...thisWeek.map((d) => d.practisedCount))} of{" "}
        {summary.joinedCount} this week
      </p>
      <ol className="class-attendance-strip">
        {thisWeek.map((day, index) => (
          <li key={day.day}>
            <span className="class-attendance-day">{WEEKDAYS[index % WEEKDAYS.length]}</span>
            {/* The count is written out, not only encoded in the bar's height —
                motion and colour are never the only carrier. */}
            <span className="class-attendance-value">{day.practisedCount}</span>
          </li>
        ))}
      </ol>
      <p className="hint">
        Practice days only. No pupil’s attendance is shown beside a performance figure, because
        there is no performance figure.
      </p>

      {worth !== null && (
        <div className="class-worth">
          <h3>Worth a lesson</h3>
          <p>
            <span lang={code}>{worth.grapheme}</span> is hard for {worth.working} of{" "}
            {summary.joinedCount} — a class problem, not {worth.working} individual ones.
          </p>
        </div>
      )}

      {notJoined !== null && notJoined > 0 && (
        <p className="hint">
          {notJoined} {notJoined === 1 ? "pupil has" : "pupils have"} not joined. Nothing about
          them appears here, including whether they have practised.
        </p>
      )}
    </section>
  );
}
