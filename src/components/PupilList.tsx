/**
 * The class list — Teacher board 1g.
 *
 * "Alphabetical · the only order there is" is on the screen because it is the
 * honest description, not a caption. There is no sort control here and no
 * column that could carry one: the rows hold attendance and which sounds
 * somebody is working on, and neither is something to rank a class by.
 *
 * A pupil who joined without a name is labelled and otherwise ordinary. The
 * board: it "needs no explanation" — so the row is not marked as incomplete,
 * greyed, or pushed to the bottom with an apology.
 */

import type { PupilRow } from "../teacher/roster.js";

export interface PupilListProps {
  rows: readonly PupilRow[];
  /** Days to draw in the attendance strip, oldest first. */
  week: readonly string[];
  onOpen?: (label: string) => void;
}

export function PupilList({ rows, week, onOpen }: PupilListProps) {
  return (
    <section className="pupil-list">
      <h2>
        {rows.length} {rows.length === 1 ? "pupil" : "pupils"} joined
      </h2>
      <p className="hint">Alphabetical — the only order there is.</p>

      <ul className="pupil-rows">
        {rows.map((row) => (
          <li key={row.label}>
            {onOpen === undefined ? (
              <span className="pupil-name">{row.label}</span>
            ) : (
              <button type="button" className="ghost pupil-name" onClick={() => onOpen(row.label)}>
                {row.label}
              </button>
            )}

            <span className="pupil-days">
              {row.days.length} {row.days.length === 1 ? "day" : "days"}
            </span>

            {/*
              Five weekdays of attendance and nothing else. Each day is written
              as well as drawn, because a row of squares is a figure encoded in
              colour — and this product does not let colour be the only carrier.
            */}
            <ol className="pupil-strip" aria-label={`Practice days for ${row.label}`}>
              {week.map((day) => {
                const practised = row.days.includes(day);
                return (
                  <li key={day} className={practised ? "is-on" : undefined}>
                    <span className="visually-hidden">
                      {day} {practised ? "practised" : "did not practise"}
                    </span>
                    <span aria-hidden="true" />
                  </li>
                );
              })}
            </ol>
          </li>
        ))}
      </ul>

      {rows.some((row) => row.anonymous) && (
        <p className="hint">
          A numbered pupil joined without a name, which is their right and needs no explanation.
        </p>
      )}
    </section>
  );
}
