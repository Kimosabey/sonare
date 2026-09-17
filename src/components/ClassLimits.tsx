/**
 * What a teacher will and will not see — Teacher board 1a, and the limits page
 * at 1h.
 *
 * The board is explicit that this is "the first screen, not a settings page
 * nobody opens — because a teacher who expects a gradebook and finds none will
 * otherwise spend a week looking for it". So it is written to be read once,
 * before anything else, and to answer the question it raises rather than leave
 * it.
 *
 * Both lists come from `teacher/promise.ts`, which is also where the pupil's
 * copy of the same promise comes from. That is the mechanism behind the
 * board's "neither side is told a different story": not a convention, a single
 * module, with a test that the teacher's denials cover every one of the
 * pupil's.
 *
 * The capability table is the 1h half — the questions a teacher actually
 * arrives with, answered yes or no rather than described.
 */

import {
  CLASS_CAPABILITIES,
  TEACHER_WILL_NOT_SEE,
  TEACHER_WILL_SEE,
  WHY_NOT_PER_PUPIL,
} from "../teacher/promise.js";

export interface ClassLimitsProps {
  /** Shows the capability table. Off for the first-run screen, on for 1h. */
  showCapabilities?: boolean;
}

export function ClassLimits({ showCapabilities = false }: ClassLimitsProps) {
  return (
    <section className="class-limits">
      <h2>What you will see, and what you will not</h2>

      {/*
        The sentence everything else follows from, and the reason this screen
        is first. Unparaphrased — it is copy that carries a constraint.
      */}
      <p className="what">
        Sonare scores pronunciation syllable by syllable. Whether that scorer is fair across
        accents has not been measured — so it does not put a number about a named child in front
        of you. Everything below follows from that one sentence.
      </p>

      <h3>You will see</h3>
      <ul className="promise-list">
        {TEACHER_WILL_SEE.map((fact) => (
          <li key={fact.label}>
            {fact.label}
          </li>
        ))}
      </ul>

      <h3>You will not see</h3>
      <ul className="promise-list">
        {TEACHER_WILL_NOT_SEE.map((fact) => (
          <li key={fact.label}>
            {fact.label}
          </li>
        ))}
      </ul>

      <h3>Why not per pupil</h3>
      {WHY_NOT_PER_PUPIL.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}

      {showCapabilities && (
        <>
          <h3>What you can and cannot do</h3>
          <div className="table-scroll">
            <table className="class-capabilities">
              <thead>
                <tr>
                  <th scope="col">Can I…</th>
                  <th scope="col">Answer</th>
                </tr>
              </thead>
              <tbody>
                {CLASS_CAPABILITIES.map((capability) => (
                  <tr key={capability.request}>
                    <th scope="row">{capability.request}</th>
                    <td>
                      {/*
                        The word, not only a tick. Colour and glyph are never
                        the only carrier, and "No — it is not stored against a
                        class" is a different answer from "No — you lack
                        permission", which a tick cannot say.
                      */}
                      <b>{capability.allowed ? "Yes" : "No"}</b>{" "}
                      <span className="hint">{capability.answer}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
