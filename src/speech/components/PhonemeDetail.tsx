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

import type { ScoredSyllable, ScoredWord } from "../scoring/types.js";
import { band } from "./band.js";
import { SyllableChips } from "./SyllableChips.js";
import { memo } from "react";

interface PhonemeDetailProps {
  word: ScoredWord;
  id?: string;
  /** BCP-47 tag for the language being taught — see WordChips. */
  lang?: string;
  /** Tap a syllable to hear that slice of the take — see useSyllablePlayback. */
  onSelectSyllable?: (syllable: ScoredSyllable, index: number) => void;
  /** Offset of the syllable currently sounding, or null. */
  playingOffsetTicks?: number | null;
}

function PhonemeDetailBase({ word, id, lang, onSelectSyllable, playingOffsetTicks }: PhonemeDetailProps) {
  /**
   * `?? []` because this word may have been restored from browser-persisted
   * progress rather than received from the server — a saved session can
   * predate a field becoming required, and a type cannot make a claim about
   * JSON written before it existed. Same guard, same reason, in report.ts.
   */
  /**
   * What happened to this word, in the learner's language.
   *
   * This used to print `error type: Omission` in red, straight from the
   * provider, to every learner. Two things were wrong with it.
   *
   * It is vendor vocabulary. The screen already decided that raw provider
   * detail is "real support value and the wrong audience" and put the error
   * code and domain behind `?debug=1`; this panel was showing the same class
   * of thing unconditionally.
   *
   * And it disagreed with the chip the learner had just tapped. `WordChips`
   * gets this right — an omitted word shows `—` and the note "not said",
   * because as its comment says, "Azure reports 0, and 0 out of 100 is a
   * claim about pronunciation that nothing measured." Tapping that chip then
   * said the system had failed to return data. Same fact, two explanations,
   * and the worse one was the one you got for asking.
   *
   * An unrecognised type says nothing rather than printing itself: the raw
   * value is already on the stored attempt for support, and a learner cannot
   * act on a word they have never seen.
   */
  const stateNote =
    word.errorType === "Omission"
      ? "You didn’t say this word — so there is nothing to score here."
      : word.errorType === "Insertion"
        ? "You said this word, but it isn’t in the phrase."
        : null;

  const syllables = word.syllables ?? [];
  const phonemes = word.phonemes ?? [];

  // Only worth a row when the provider actually named them. Every shipped
  // locale returns them empty; en-US does not.
  const labelledPhonemes = phonemes.filter((p) => p.phoneme);

  return (
    <div className="phonemes" id={id}>
      {/*
        Skipped for an omitted word. It has zero syllables — because nothing
        was said — and SyllableChips reads zero as "the provider returned no
        detail for this word", which is a statement about the response rather
        than about the take. `stateNote` above says the true thing instead.
      */}
      {word.errorType !== "Omission" && (
      <SyllableChips
        syllables={syllables}
        lang={lang}
        {...(onSelectSyllable ? { onSelect: onSelectSyllable } : {})}
        playingOffsetTicks={playingOffsetTicks ?? null}
      />
      )}

      {/* Rendered into this same container, not a nested `.phonemes` one:
          WordChips asserts exactly one expanded panel exists, and a second
          element carrying that class counts as a second panel. */}
      {labelledPhonemes.map((p, i) => (
        <span key={`${p.phoneme}-${i}`} className={`p ${band(p.accuracy)}`}>
          {p.phoneme} <b>{Math.round(p.accuracy)}</b>
        </span>
      ))}

      {stateNote !== null && <div className="hint word-state">{stateNote}</div>}
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
