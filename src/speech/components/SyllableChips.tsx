/**
 * Per-syllable scores for one word — the per-sound surface that actually
 * carries information.
 *
 * Azure returns empty `Phoneme` labels for every locale Sonare ships, so
 * PhonemeDetail can only ever number its sounds. Syllables come back scored
 * and timed 100% of the time, and named by their `grapheme` most of the time:
 * 91 of 110 across the ten French targets (83%), de-DE 8/8, es-ES 8/10,
 * hi-IN 0/108. A grapheme is also the better teaching surface of the two —
 * most learners cannot read phonetic notation, but they can re-read a piece
 * of the word they just said.
 */

import { memo } from "react";
import type { ScoredSyllable } from "../scoring/types.js";
import { band } from "./band.js";

interface SyllableChipsProps {
  /**
   * One word's syllables, in the order they were spoken. Empty is a real
   * case, not a bug — PRD §6 promises the array, not its contents.
   */
  syllables: ScoredSyllable[];
  /**
   * Tap-to-replay, wired in a later step: `offsetTicks`/`durationTicks` are
   * enough to slice this syllable out of the take the learner just recorded.
   * Given a handler, every chip becomes a real button; without one they are
   * static text. Nothing here plays audio — this component stays
   * presentational.
   *
   * Pass a `useCallback`'d function: an inline arrow defeats the memo below.
   */
  onSelect?: (syllable: ScoredSyllable, index: number) => void;
  /** So a parent can point `aria-controls` at this panel, as WordChips does. */
  id?: string;
}

const ORDINAL_SUFFIX = ["th", "st", "nd", "rd"];

/**
 * "1st", "2nd", "3rd", "4th".
 *
 * The teens branch cannot fire on real data — the longest word across the
 * four activity sets is four syllables — but it costs one comparison, and
 * "11st" on a learner's screen is the kind of detail that makes every other
 * number on the screen look untrustworthy.
 */
function ordinal(n: number): string {
  const tens = n % 100;
  // Indexed read under noUncheckedIndexedAccess: 4-9 are legitimately absent.
  const suffix = tens >= 11 && tens <= 13 ? "th" : (ORDINAL_SUFFIX[n % 10] ?? "th");
  return `${n}${suffix}`;
}

const NO_SYLLABLES_COPY = "no syllable detail returned for this word";

/**
 * Shown only when the provider named none of them, which in practice means
 * Devanagari: hi-IN returned 0 graphemes out of 108 syllables across all ten
 * of its activity targets, while scoring and timing every one. For a Hindi
 * learner the positional label is not a fallback for the odd miss — it is the
 * entire per-syllable experience, permanently. One line of explanation is
 * what separates "labelled by position, on purpose" from "the words failed to
 * load". It is deliberately absent in the mixed case (fr-FR, es-ES), where
 * the named chips beside it already make the pattern obvious.
 */
const UNNAMED_COPY =
  "This language scores and times every syllable but returns no written form, so they are labelled by position.";

function SyllableChipsBase({ syllables, onSelect, id }: SyllableChipsProps) {
  const total = syllables.length;
  const noneNamed = total > 0 && syllables.every((s) => !s.grapheme);

  return (
    <div className="syllables" id={id}>
      {total === 0 ? (
        <span className="hint">{NO_SYLLABLES_COPY}</span>
      ) : (
        syllables.map((s, i) => {
          const named = s.grapheme.length > 0;
          const score = Math.round(s.accuracy);
          /**
           * The chip itself is identical either way — same ground, same
           * banded rule, same size. Only the label glyphs differ, because an
           * unnamed syllable is a different label, not a damaged chip. See
           * UNNAMED_COPY: a whole language only ever sees this state.
           */
          const chipClass = `sy ${band(s.accuracy)}`;
          /**
           * Read aloud, "2nd 70" is not a sentence in any language, so the
           * visible label is hidden from assistive tech and restated once as
           * one. That also puts the syllable count in the only place it is
           * actually needed: a sighted reader can see there are three chips,
           * a screen reader user cannot. Colour is never the sole carrier of
           * the score — the numeral is real text, and this is its context.
           */
          const spoken = `${named ? s.grapheme : `syllable ${i + 1} of ${total}`}, scored ${score} out of 100`;
          const body = (
            <>
              <span className={named ? "sy-grapheme" : "sy-pos"} aria-hidden="true">
                {named ? s.grapheme : ordinal(i + 1)}
              </span>
              <b className="sy-score" aria-hidden="true">
                {score}
              </b>
              <span className="sr-only">{spoken}</span>
            </>
          );
          // Ticks, not the grapheme, are the stable identity here: an entire
          // locale's graphemes are empty strings, which would key every chip
          // in a Hindi word identically.
          const key = `${s.offsetTicks}-${i}`;
          // Capped stagger, as in WordChips — past the first few chips the
          // extra delay is just waiting.
          const style = { animationDelay: `${Math.min(i, 6) * 30}ms` };

          return onSelect ? (
            <button key={key} type="button" className={chipClass} style={style} onClick={() => onSelect(s, i)}>
              {body}
            </button>
          ) : (
            <span key={key} className={chipClass} style={style}>
              {body}
            </span>
          );
        })
      )}
      {noneNamed && <p className="sy-note">{UNNAMED_COPY}</p>}
    </div>
  );
}

/**
 * Memoised because the level meter drives a 30Hz state update on the page that
 * renders this. Without a bail-out, every component in that subtree re-rendered
 * thirty times a second for the whole take — on the exact frames the recording
 * UI needs to stay smooth. Props here are referentially stable between level
 * ticks (the report is useMemo'd), so the comparison genuinely short-circuits
 * rather than just moving the cost — provided `onSelect` is useCallback'd,
 * which is the one prop a caller can get wrong.
 */
export const SyllableChips = memo(SyllableChipsBase);
