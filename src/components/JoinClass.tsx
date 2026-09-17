/**
 * The decision to join a class — Teacher board 1c, on the pupil's phone.
 *
 * The board: "Joining is a decision with the consequences listed, in a pupil's
 * words — and the list is the same one the teacher was shown, so neither side
 * is told a different story." Both lists come from `teacher/promise.ts`, which
 * is also where the teacher's limits screen reads them, and the two are tied
 * by key rather than by wording so neither can quietly stop denying something.
 *
 * ── three choices, and the middle one is the point ─────────────────────────
 *
 * "Join without my name" is a peer of "Join the class", not a link underneath
 * it. A name list is itself a privacy surface — board 1b says so on the
 * teacher's side — and a pupil who wants the lesson without being on a list
 * should not have to hunt for that, or read it as the awkward option.
 *
 * "Not now" is last and is not destructive. Nothing about a pupil reaches a
 * teacher before this screen is answered, so declining is simply leaving,
 * which is why it is worded as a postponement rather than a refusal.
 *
 * The reversibility is stated on the screen rather than in a help page,
 * because it is the fact that makes the decision safe to make: a pupil can
 * leave at any time, and can remove their name without leaving.
 */

import { NEVER_SHARED_WITH_CLASS, SHARED_WITH_CLASS } from "../teacher/promise.js";

export interface JoinClassProps {
  className: string;
  /** How the teacher is named to the pupil, e.g. "Mr Okonjo". */
  teacherName: string;
  /** The pupil's name on this device, or null if they never gave one. */
  learnerName?: string | null;
  busy?: boolean;
  onJoin: (options: { shareName: boolean }) => void;
  onDecline: () => void;
}

export function JoinClass({
  className,
  teacherName,
  learnerName = null,
  busy = false,
  onJoin,
  onDecline,
}: JoinClassProps) {
  return (
    <section className="join-class">
      <h2>Join {className}?</h2>
      <p className="what">
        {teacherName} will be able to see some things about your practice. Here is all of it.
      </p>

      <h3>They will see</h3>
      <ul className="promise-list">
        {SHARED_WITH_CLASS.map((fact) => (
          <li key={fact.label}>
            {/*
              The name fact is shown as it actually applies. "Your first name,
              if you gave one" is the general promise; a pupil deciding right
              now needs to see the name that would travel, or they are agreeing
              to something they have to go and look up.
            */}
            <b>
              {fact.label.startsWith("Your first name") && learnerName !== null
                ? `Your first name, ${learnerName}`
                : fact.label}
            </b>
            <span className="hint">{fact.because}</span>
          </li>
        ))}
      </ul>

      <h3>They will never see</h3>
      <ul className="promise-list">
        {NEVER_SHARED_WITH_CLASS.map((fact) => (
          <li key={fact.label}>
            <b>{fact.label}</b>
            <span className="hint">{fact.because}</span>
          </li>
        ))}
      </ul>

      <p>
        Your sounds are yours. What the class shares is how hard each sound is for the whole
        group, with nobody named in it.
      </p>
      <p className="hint">
        You can leave the class at any time, and remove your name without leaving.
      </p>

      <div className="join-class-actions">
        <button type="button" onClick={() => onJoin({ shareName: true })} disabled={busy}>
          {busy ? "Joining…" : "Join the class"}
        </button>
        {/*
          A peer of the button above rather than a link below it. Only offered
          when there is a name to withhold — with none given, the two buttons
          would do exactly the same thing and the choice would be theatre.
        */}
        {learnerName !== null && (
          <button type="button" onClick={() => onJoin({ shareName: false })} disabled={busy}>
            Join without my name
          </button>
        )}
        <button type="button" className="ghost" onClick={onDecline} disabled={busy}>
          Not now
        </button>
      </div>
    </section>
  );
}
