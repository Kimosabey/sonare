/**
 * The written options a `listen` activity asks the learner to choose between.
 *
 * The exercise is discrimination: the model says one phrase, and the options
 * are that phrase plus authored near-misses — `poisson` against `poison`. So
 * the options are the *content* here, not a control, and they are set at the
 * weight content gets rather than as a row of buttons under a prompt.
 *
 * One answer, then the outcome. `affordancesFor` gives this kind an attempt
 * limit of one: a learner choosing between two or four written phrases either
 * heard the difference or did not, and a second guess is elimination. With two
 * options it would be certain. What follows a wrong answer is not another go
 * but the right answer shown beside it, which is where the learning is.
 */

import type { ListenOption } from "../activities/listen.js";

export interface ListenOptionsProps {
  options: ListenOption[];
  /** BCP-47 tag for the language the options are written in. */
  code: string;
  /** The id already chosen, or null while the question is open. */
  chosen: string | null;
  onChoose: (option: ListenOption) => void;
}

export function ListenOptions({ options, code, chosen, onChoose }: ListenOptionsProps) {
  /**
   * Content the gate refuses and `listenOptions` refuses again — one option,
   * or a near-miss identical to the target. Rendering nothing is the honest
   * answer: a single always-right button teaches nothing, and two identical
   * options would tell a learner who picked the right words that they were
   * wrong.
   */
  if (options.length === 0) {
    return (
      <p className="what" role="status">
        This question isn&rsquo;t ready yet. Skip on to the next one.
      </p>
    );
  }

  const answered = chosen !== null;

  return (
    <ul className="listen-options" aria-label="Which phrase did you hear?">
      {options.map((option) => {
        const picked = option.id === chosen;
        /**
         * After an answer the right one is always marked, not only when the
         * learner found it. Showing "wrong" without showing what was right
         * leaves them knowing they failed and not what they missed, which is
         * the one thing this activity exists to teach.
         */
        const state = !answered ? "" : option.correct ? " is-correct" : picked ? " is-wrong" : "";

        return (
          <li key={option.id}>
            <button
              type="button"
              className={`listen-option${state}`}
              disabled={answered}
              /**
               * `aria-pressed` rather than a live region per option: a screen
               * reader user tabbing the list after answering hears the state
               * of each one as they reach it. The outcome as a whole is
               * announced once, by the verdict the screen renders below.
               */
              aria-pressed={picked}
              onClick={() => onChoose(option)}
            >
              {/*
                The one field in the language being taught, so it carries
                `lang` (WCAG 3.1.2). Without it a screen reader says a French
                phrase in an English voice — in an activity whose entire
                subject is how the phrase sounds.
              */}
              <span lang={code}>{option.text}</span>
              {answered && option.correct && (
                <span className="listen-mark" aria-label="correct">
                  ✓
                </span>
              )}
              {answered && picked && !option.correct && (
                <span className="listen-mark" aria-label="what you picked">
                  ✕
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
