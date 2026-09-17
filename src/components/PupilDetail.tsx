/**
 * One pupil — Teacher board 1g, the right-hand half.
 *
 * The board states what this screen is for: "Opening a pupil gives a teacher
 * one thing to do: have a word." Everything on it is either a fact a
 * conversation could start from, or the device check that might explain why
 * the conversation is needed.
 *
 * There is no figure here, and the screen says so. That line is not
 * reassurance — it is the answer to the question a teacher arrives with, and
 * leaving it unanswered is what sends somebody hunting through menus for the
 * score they assume must exist.
 */

import { captureNeedsAttention, daysSincePractice, type PupilRow } from "../teacher/roster.js";

export interface PupilDetailProps {
  row: PupilRow;
  /** BCP-47 code, so the sounds carry their language. */
  code: string;
  today?: Date;
  /** The sounds the whole class is working on, to say whether this pupil is with them. */
  classSounds?: readonly string[];
}

export function PupilDetail({ row, code, today = new Date(), classSounds = [] }: PupilDetailProps) {
  const since = daysSincePractice(row, today);
  const shared = row.workingOn.filter((sound) => classSounds.includes(sound));

  return (
    <section className="pupil-detail">
      <h2>{row.label}</h2>

      <p className="what">
        {since === null
          ? "Has not practised yet."
          : since === 0
            ? "Practised today."
            : `Has not practised in ${since} ${since === 1 ? "day" : "days"}.`}
      </p>

      <h3>Working on</h3>
      {row.workingOn.length === 0 ? (
        <p className="hint">No sounds yet.</p>
      ) : (
        <>
          <p lang={code}>{row.workingOn.join(" · ")}</p>
          {shared.length > 0 && (
            <p className="hint">
              {shared.length === row.workingOn.length
                ? "The same sounds the class is on."
                : `${shared.length} of these are what the class is on.`}
            </p>
          )}
        </>
      )}
      <p className="hint">Which sounds, not how well. There is no figure on this page.</p>

      {/*
        The R8 indeterminate count, and the board is right that it is the most
        useful thing here: "usually a microphone or a room, not a pupil — and
        it is the one thing on this screen that might explain a pupil quietly
        giving up".
      */}
      {row.capture !== null && captureNeedsAttention(row) && (
        <div className="pupil-capture">
          <h3>Worth knowing</h3>
          <p>
            {row.capture.unusable} of {row.label}’s last {row.capture.total} takes came back
            unusable. That is usually a microphone or a room, not a pupil.
          </p>
          <p className="hint">
            A take the app could not hear is never scored and never counted against them — so
            this is the one thing here that might explain somebody quietly giving up.
          </p>
        </div>
      )}

      <p className="hint">
        What this page offers is a conversation and a device check. Nothing on it could be read
        out to a room.
      </p>
    </section>
  );
}
