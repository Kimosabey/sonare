/**
 * The pupil's own copy of what their class can see — board 1h, right half.
 *
 * The board puts it on the You tab "so a pupil can check the promise rather
 * than take it". That word is the design: this screen exists to be *checked*,
 * which means it has to be complete and it has to carry the two controls that
 * make the promise reversible. A page that only restated the policy would be
 * the promise again, not a way to hold anyone to it.
 *
 * ── two exits, not one ─────────────────────────────────────────────────────
 *
 * "Remove my name" and "Leave the class" are different things and both are
 * offered. A pupil who wants out of a name list but still wants the lesson
 * suggestions should not have to leave; and leaving should not be the price of
 * changing their mind about being named.
 *
 * Neither is destructive to anything they have learned, and the screen says so
 * in the board's own words — "Leaving keeps everything you have learned. It
 * only stops the sharing." Without that line, leaving reads like deleting.
 */

import {
  NEVER_SHARED_WITH_CLASS,
  SHARED_WITH_CLASS,
} from "../teacher/promise.js";

export interface MyClassProps {
  className: string;
  teacherName: string;
  /** ISO day they joined. */
  joinedAt: string;
  /** The name they are sharing, or null if they joined without one. */
  sharedName: string | null;
  busy?: boolean;
  onRemoveName: () => void;
  onLeave: () => void;
}

export function MyClass({
  className,
  teacherName,
  joinedAt,
  sharedName,
  busy = false,
  onRemoveName,
  onLeave,
}: MyClassProps) {
  return (
    <div className="my-class">
      <h3 className="today-heading">Your class · {className}</h3>
      <p className="hint">
        Joined {joinedAt}
        {sharedName === null ? " · without a name" : ` · as ${sharedName}`}
      </p>

      <h4>{teacherName} can see</h4>
      <ul className="promise-list">
        {SHARED_WITH_CLASS.map((fact) => (
          <li key={fact.label}>{fact.label}</li>
        ))}
      </ul>

      <h4>And cannot</h4>
      <ul className="promise-list">
        {NEVER_SHARED_WITH_CLASS.map((fact) => (
          <li key={fact.label}>{fact.label}</li>
        ))}
      </ul>

      {/*
        The board's line, and it is load-bearing: this screen reads the same
        source the teacher's view is built from, so a pupil is not being shown
        a friendlier copy of the policy.
      */}
      <p className="hint">This reads the same list the class view is built from.</p>

      <div className="my-class-actions">
        {/*
          Only offered when there is a name to remove. With none shared, the
          button would do nothing and imply a name is on file that is not.
        */}
        {sharedName !== null && (
          <button type="button" className="ghost" onClick={onRemoveName} disabled={busy}>
            Remove my name
          </button>
        )}
        <button type="button" className="ghost" onClick={onLeave} disabled={busy}>
          Leave the class
        </button>
      </div>
      <p className="hint">
        Leaving keeps everything you have learned. It only stops the sharing.
      </p>
    </div>
  );
}
