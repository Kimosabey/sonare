/**
 * What a course covers, in the vocabulary a department buys in.
 *
 * `cefr.ts` has mapped every activity to a level and a can-do statement since
 * it was written, and **nothing rendered it**. So the answer to "what does
 * this course cover" was a list of phrases, or reading the source. A head of
 * department justifies a purchase against a syllabus, and until this screen
 * existed there was nothing to hand them.
 *
 * ## Why it says what is covered and never what a learner has reached
 *
 * Every figure elsewhere in the teacher's view is about a class as a group,
 * because a number attached to a named child is the thing the class boundary
 * exists to prevent. A CEFR level is exactly the kind of number that invites
 * the other reading — "Maya is A2" — so this component takes activity ids and
 * describes **content**. It is given no learner, no progress and no standing,
 * which is the cheapest way to make the wrong version unbuildable rather than
 * merely discouraged.
 *
 * ## Why the ceiling is stated
 *
 * The material is functional beginner language and reaches A2. Saying so is
 * the honest claim and it is also the useful one: a department buying for a
 * B1 cohort should find that out here rather than in the first lesson.
 */

import { cefrMapFor, type CefrEntry, type CefrLevel } from "../activities/cefr.js";

export interface CourseSyllabusProps {
  /** Language slug — "fr", "es", "de". */
  slug: string;
  /** The label a teacher reads, e.g. "French". */
  label: string;
  /** Activity ids the course actually contains. */
  activityIds: readonly number[];
}

const LEVEL_ORDER: readonly CefrLevel[] = ["A1", "A2"];

export function CourseSyllabus({ slug, label, activityIds }: CourseSyllabusProps) {
  const ids = new Set(activityIds);
  /**
   * Only what this course contains. The map for a language covers the bundled
   * set and the course additions together, and a bundled-only deployment must
   * not advertise the course's can-dos — that would be a syllabus describing
   * content the learners in front of this teacher cannot reach.
   */
  const covered = cefrMapFor(slug).filter((entry) => entry.ids.some((id) => ids.has(id)));

  if (covered.length === 0) {
    return (
      <>
        <h2>What {label} covers</h2>
        <p className="what">
          Nothing is mapped to a syllabus for this course yet. That is a gap in our
          description of it, not in the course.
        </p>
      </>
    );
  }

  const byLevel = LEVEL_ORDER.map((level) => ({
    level,
    speaking: covered.filter((e) => e.level === level && e.skill === "speaking"),
    listening: covered.filter((e) => e.level === level && e.skill === "listening"),
  })).filter(({ speaking, listening }) => speaking.length + listening.length > 0);

  return (
    <>
      <h2>What {label} covers</h2>
      <p className="what">
        Common European Framework levels, by what a learner can do. This describes the
        course, never a pupil — nothing here says what anybody has reached.
      </p>

      {byLevel.map(({ level, speaking, listening }) => (
        <section key={level} className="syllabus-level">
          <h3>
            {level} — {countLabel(speaking.length + listening.length)}
          </h3>
          {speaking.length > 0 && <CanDoList entries={speaking} />}
          {listening.length > 0 && (
            <>
              {/*
                Named separately because the framework separates them, and
                because the distinction is real: hearing a difference is not
                being able to produce it, and a syllabus that merged the two
                would overstate what the course teaches.
              */}
              <h4 className="syllabus-skill">Listening</h4>
              <CanDoList entries={listening} />
            </>
          )}
        </section>
      ))}

      <p className="hint">
        Nothing in this course goes beyond A2. It is functional beginner language, and a
        cohort working at B1 would outgrow it.
      </p>
    </>
  );
}

function CanDoList({ entries }: { entries: readonly CefrEntry[] }) {
  return (
    <ul className="syllabus-list">
      {entries.map((entry) => (
        <li key={entry.ids.join("-")}>{entry.canDo}</li>
      ))}
    </ul>
  );
}

/** "one thing" reads better than "1 things", and a teacher reads this once. */
function countLabel(n: number): string {
  return n === 1 ? "one thing a learner can do" : `${String(n)} things a learner can do`;
}
