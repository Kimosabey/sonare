/**
 * T13/FR-23 — the detail behind one word: its syllables, its phonemes where
 * they exist, and its error type.
 *
 * Syllables lead because they are the level Azure actually labels. Phonemes
 * come back with real scores and **empty labels** for every locale this
 * product ships (fr-FR, es-ES, de-DE, hi-IN), so this panel used to render a
 * row of "sound 1, sound 2, sound 3" — true, and useless to a learner.
 * Syllables carry a written grapheme instead: 83% of them across the French
 * activity set, and always a score and a time range.
 *
 * The phoneme row is kept rather than deleted because it is not universally
 * dead: en-US returns fully labelled phonemes (21 of 21 measured), and the
 * fixture runner can select en-US. So it renders when the labels are real and
 * stands aside when they are not, instead of showing a second numbered row
 * beside the syllables that already say it better.
 */

import type { ScoredWord } from "../scoring/types.js";
import { band } from "./band.js";
import { SyllableChips } from "./SyllableChips.js";
import { memo } from "react";

interface PhonemeDetailProps {
  word: ScoredWord;
  id?: string;
  /** BCP-47 tag for the language being taught — see WordChips. */
  lang?: string;
}

function PhonemeDetailBase({ word, id, lang }: PhonemeDetailProps) {
  /**
   * `?? []` because this word may have been restored from browser-persisted
   * progress rather than received from the server — a saved session can
   * predate a field becoming required, and a type cannot make a claim about
   * JSON written before it existed. Same guard, same reason, in report.ts.
   */
  const syllables = word.syllables ?? [];
  const phonemes = word.phonemes ?? [];

  // Only worth a row when the provider actually named them. Every shipped
  // locale returns them empty; en-US does not.
  const labelledPhonemes = phonemes.filter((p) => p.phoneme);

  return (
    <div className="phonemes" id={id}>
      <SyllableChips syllables={syllables} lang={lang} />

      {/* Rendered into this same container, not a nested `.phonemes` one:
          WordChips asserts exactly one expanded panel exists, and a second
          element carrying that class counts as a second panel. */}
      {labelledPhonemes.map((p, i) => (
        <span key={`${p.phoneme}-${i}`} className={`p ${band(p.accuracy)}`}>
          {p.phoneme} <b>{Math.round(p.accuracy)}</b>
        </span>
      ))}

      {word.errorType && word.errorType !== "None" && (
        <div style={{ marginTop: 8, color: "var(--fail)" }}>error type: {word.errorType}</div>
      )}
    </div>
  );
}

/**
 * Memoised because the level meter drives a 30Hz state update on the page that
 * renders this. Without a bail-out, every component in that subtree re-rendered
 * thirty times a second for the whole take — on the exact frames the recording
 * UI needs to stay smooth. Props here are referentially stable between level
 * ticks (callbacks are useCallback'd, the report is useMemo'd), so the
 * comparison genuinely short-circuits rather than just moving the cost.
 */
export const PhonemeDetail = memo(PhonemeDetailBase);
