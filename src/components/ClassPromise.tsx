/**
 * What a class can and cannot see about you — board 1h's right-hand panel.
 *
 * On the pupil's own phone, reachable from the You tab, "so a pupil can check
 * the promise rather than take it". It renders `SHARED_WITH_CLASS` and
 * `NEVER_SHARED_WITH_CLASS` directly: the same two lists the teacher's limits
 * panel is built from, so neither side can be told a different story.
 *
 * Shown whether or not the learner is in a class. Before joining it is the
 * information the decision needs — board 1c puts the same list in front of the
 * join button — and afterwards it is the receipt.
 */

import {
  NEVER_SHARED_WITH_CLASS,
  SHARED_WITH_CLASS,
} from "../teacher/promise.js";

export interface ClassPromiseProps {
  /** The class's name once joined, or null before a decision has been made. */
  className?: string | null;
  /** The name shared, or null when the learner joined without one. */
  sharedName?: string | null;
}

export function ClassPromise({ className = null, sharedName = null }: ClassPromiseProps) {
  return (
    <div className="class-promise">
      <h3 className="today-heading">
        {className === null ? "If you join a class" : `Your class · ${className}`}
      </h3>

      <h4>They can see</h4>
      <ul className="promise-list">
        {SHARED_WITH_CLASS.map((fact) => (
          <li key={fact.label}>
            <b>{fact.label}</b>
            <span className="hint">{fact.because}</span>
          </li>
        ))}
      </ul>

      {/*
        Named only when a name is actually being shared. "Your first name, if
        you gave one" is the general promise; a learner who joined without one
        should not read a line implying otherwise.
      */}
      {sharedName !== null && (
        <p className="hint">
          The name they see is <b>{sharedName}</b>.
        </p>
      )}

      <h4>They can never see</h4>
      <ul className="promise-list promise-never">
        {NEVER_SHARED_WITH_CLASS.map((fact) => (
          <li key={fact.label}>
            <b>{fact.label}</b>
            <span className="hint">{fact.because}</span>
          </li>
        ))}
      </ul>

      {/*
        The sentence that makes the list mean something. Three of these are not
        settings an administrator can turn on — the class view is never given
        the data, so there is nothing to reveal.
      */}
      <p className="what">
        These are not settings. A class is never given your scores or your
        recordings, so there is nothing that could be switched on to show them.
      </p>

      {className !== null && (
        <p className="hint">
          Leaving keeps everything you have learned. It only stops the sharing.
        </p>
      )}
    </div>
  );
}
