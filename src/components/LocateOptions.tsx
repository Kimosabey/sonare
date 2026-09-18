/**
 * "Which sound was in that?" — the options a `locate` activity offers.
 *
 * The model plays the phrase and the learner picks the written syllable it
 * contained. The options are **syllables**, which is what makes this the
 * perception half of everything else the product asks: the skills store keys
 * on exactly these, the report names them, and until now a learner was asked
 * to produce a sound they had never been asked to recognise.
 *
 * The phrase is not on screen until the question is over. It contains the
 * answer, so showing it would turn a listening exercise into a reading one —
 * the same trap the `listen` kind fell into once, where the options were
 * written French forms and the audio could be muted.
 *
 * One answer, then the outcome. With four options a second guess is worth a
 * third of a right answer, and what follows a wrong one is not another go but
 * the phrase revealed with the syllable marked in it, which is where the
 * learning is.
 */

import type { LocateOption } from "../activities/locate.js";

export interface LocateOptionsProps {
  options: readonly LocateOption[];
  /** BCP-47 tag — the options are syllables of the language being learnt. */
  code: string;
  /** The phrase the model said, shown once the question is over. */
  target: string;
  /** What the learner picked, or null before they have. */
  chosen?: string | null;
  onChoose: (grapheme: string) => void;
}

export function LocateOptions({
  options,
  code,
  target,
  chosen = null,
  onChoose,
}: LocateOptionsProps) {
  const answered = chosen !== null;
  const correct = options.find((option) => option.correct)?.grapheme ?? "";

  return (
    <div className="locate">
      <p className="what">Which sound was in that?</p>

      <ul className="locate-options">
        {options.map((option) => {
          const picked = chosen === option.grapheme;
          const reveal = answered && (option.correct || picked);

          return (
            <li key={option.grapheme}>
              <button
                type="button"
                className={`locate-option${picked ? " is-picked" : ""}${
                  answered && option.correct ? " is-answer" : ""
                }`}
                disabled={answered}
                onClick={() => onChoose(option.grapheme)}
              >
                <span lang={code}>{option.grapheme}</span>
                {/*
                  The mark is a word to a screen reader and a glyph on screen.
                  Colour and shape are never the only carrier, and "correct" is
                  not a thing a tick can say to somebody who cannot see it.
                */}
                {reveal && (
                  <span className="locate-mark" aria-hidden="true">
                    {option.correct ? "✓" : "✕"}
                  </span>
                )}
                {reveal && (
                  <span className="visually-hidden">
                    {option.correct ? " — correct" : " — not in the phrase"}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {/*
        Only after answering, and never before: the phrase contains the answer.
      */}
      {answered && (
        <div className="locate-reveal">
          <p className="phrase" lang={code}>
            {target}
          </p>
          <p className="hint">
            <span lang={code}>{correct}</span> is in it.
          </p>
        </div>
      )}
    </div>
  );
}
