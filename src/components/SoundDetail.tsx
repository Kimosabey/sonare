/**
 * One sound, opened up — Teacher board 1e.
 *
 * The board: "The distribution is bucketed and unlabelled by pupil, so the
 * shape is readable and no bar leads anywhere." Both halves of that sentence
 * are load-bearing, and the second is the one a reader will be tempted to undo.
 *
 * **No bar is clickable.** A drill-through from a bucket is a list of children
 * at a level, which is precisely the ranking this whole view exists without.
 * The bars are `<li>` elements, not buttons, and there is no handler to add
 * one to — the component takes no callback for them.
 *
 * **The numbers are written, not only drawn.** A bar's height is a second
 * encoding of a figure that is already a word. Colour and length are never the
 * only carrier, and a teacher reading this on a projector at the back of a
 * room gets the count either way.
 *
 * "In the room" is teaching notes, which the board is explicit are "the same
 * for every class" — they are content about a sound, not data about pupils, so
 * they are authored and passed in rather than derived from anything.
 */

import { ArticulationDiagram } from "./ArticulationDiagram.js";
import { useArticulationDiagram } from "../hooks/useArticulationDiagram.js";
import type { SoundDifficulty } from "../teacher/classSummary.js";

export interface SoundNote {
  /** How the sound is made, in a teacher's words. */
  howItIsMade: string;
  /** What to do in the room. */
  inTheRoom?: string | null;
}

export interface SoundDetailProps {
  grapheme: string;
  code: string;
  difficulty: SoundDifficulty;
  joinedCount: number;
  /** The words it turns up in, from the content. */
  heardIn?: readonly string[];
  note?: SoundNote | null;
}

/** The board's three buckets, named rather than numbered. */
const BUCKETS = [
  { key: "justStarted", label: "Just started" },
  { key: "gettingThere", label: "Getting there" },
  { key: "holding", label: "Holding" },
] as const;

export function SoundDetail({
  grapheme,
  code,
  difficulty,
  joinedCount,
  heardIn = [],
  note = null,
}: SoundDetailProps) {
  const diagramFile = useArticulationDiagram(code, grapheme);
  const counts: Record<string, number> = {
    justStarted: difficulty.justStarted,
    gettingThere: difficulty.gettingThere,
    holding: difficulty.holding,
  };

  const placed = difficulty.justStarted + difficulty.gettingThere + difficulty.holding;
  const widest = Math.max(1, ...BUCKETS.map((b) => counts[b.key] ?? 0));

  return (
    <section className="sound-detail">
      <h2>
        The <span lang={code}>{grapheme}</span>
      </h2>

      {note !== null && (
        <>
          <p className="what">{note.howItIsMade}</p>
          {/*
            Beside the advice, never instead of it. The component refuses to
            render when the words are missing — a picture of a tongue cannot be
            read aloud, translated or selected, so it is the illustration and
            the sentence is the instruction.

            Absent on most builds: the diagrams are generated into
            diagram-cache/ and only move into the build once a reviewer has
            passed them. `ArticulationDiagram` renders nothing when the file is
            not there, which is the normal state rather than an error.
          */}
          <ArticulationDiagram file={diagramFile} advice={note.howItIsMade} />
        </>
      )}

      <h3>How the class sits on it</h3>
      <ol className="sound-buckets">
        {BUCKETS.map((bucket) => {
          const count = counts[bucket.key] ?? 0;
          return (
            <li key={bucket.key}>
              {/* Not a button, and there is no handler to give it. A
                  drill-through here is a list of children at a level. */}
              <span className="sound-bucket-count">{count}</span>
              <span
                className="sound-bucket-bar"
                style={{ transform: `scaleX(${count / widest})` }}
                aria-hidden="true"
              />
              <span className="sound-bucket-label">{bucket.label}</span>
            </li>
          );
        })}
      </ol>

      {/*
        Stated rather than left to arithmetic. The board's example class has
        every pupil placed, so its three bars sum to the class; a real one has
        pupils who have not reached the sound, and three bars that quietly
        described 22 of 28 pupils would be a distribution of a group the screen
        never names.
      */}
      {difficulty.notYet > 0 && (
        <p className="hint">
          {placed} of {joinedCount} pupils have reached this sound. The other {difficulty.notYet}{" "}
          have not, and are not in the shape above.
        </p>
      )}

      {heardIn.length > 0 && (
        <>
          <h3>Where it turns up</h3>
          <ul className="sound-heard-in">
            {heardIn.map((word) => (
              <li key={word} lang={code}>
                {word}
              </li>
            ))}
          </ul>
        </>
      )}

      {note?.inTheRoom != null && note.inTheRoom !== "" && (
        <>
          <h3>In the room</h3>
          <p>{note.inTheRoom}</p>
          <p className="hint">Teaching notes, not pupil data. They are the same for every class.</p>
        </>
      )}
    </section>
  );
}
