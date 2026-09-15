/**
 * "Pick the meaning" — the options a `listen` activity offers (board 1i).
 *
 * The model plays the phrase and the learner chooses what it meant, from
 * authored near-miss meanings. The options are **English**, which is what
 * makes the exercise about hearing: nothing on screen is in the language being
 * played, so there is no spelling to match against and no way to answer with
 * the audio muted.
 *
 * They are the *content* here rather than controls, and set at the weight
 * content gets — the deciding difference between two options is often one
 * word.
 *
 * One answer, then the outcome. `affordancesFor` gives this kind an attempt
 * limit of one: a learner either heard the difference or did not, and a second
 * guess is elimination — with two options, certain. What follows a wrong
 * answer is not another go but the right answer shown beside it, and the
 * phrase itself revealed, which is where the learning is.
 */

import type { ListenOption } from "../activities/listen.js";

export interface ListenOptionsProps {
  options: ListenOption[];
  /** BCP-47 tag for the phrase revealed after answering. */
  code: string;
  /** The phrase the model said, shown once the question is over. */
  target: string;
  /** What separated it from the near miss. Authored — the activity's `focus`. */
  focus: string;
  /** The id already chosen, or null while the question is open. */
  chosen: string | null;
  onChoose: (option: ListenOption) => void;
}

export function ListenOptions({
  options,
  code,
  target,
  focus,
  chosen,
  onChoose,
}: ListenOptionsProps) {
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

  const list = (
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
                Untagged, because these are English. The `lang` tag belongs on
                the phrase revealed below — putting it here would make a screen
                reader read English meanings in a French voice, which is the
                mirror of the mistake WCAG 3.1.2 exists to prevent.
              */}
              <span>{option.text}</span>
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

  if (!answered) return list;

  return (
    <>
      {list}
      {/*
        The phrase, revealed only once the question is over. Before that it is
        the answer; after it, it is the thing the learner just failed or
        managed to understand, and seeing it written is most of what makes the
        take worth having.
      */}
      <div className="listen-reveal" role="status" aria-live="polite">
        <p className="phrase" lang={code}>
          {target}
        </p>
        <p className="what">{focus}</p>
      </div>
    </>
  );
}
