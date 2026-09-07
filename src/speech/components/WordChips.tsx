/**
 * T12/FR-22 — per-word chips. Tapping opens FR-23.
 *
 * Coloured by accuracy, but *labelled* by error type, because the two answer
 * different questions and only one of them tells a learner what to do next.
 *
 * A word the learner never said comes back from Azure's miscue detection as
 * `Omission` with accuracy 0 — arithmetically the same as a word they said
 * very badly, and until now rendered the same: a red chip reading "0". Those
 * call for opposite actions. "Say this word" is a different instruction from
 * "say this word better", and a learner shown 0 on a word they skipped
 * reasonably concludes their pronunciation of it was terrible.
 *
 * 57 of the 401 words in the stored trail are omissions, so this is the
 * commonest fault in the data by a wide margin — not an edge case.
 */

import { memo, useState } from "react";
import type { ScoredSyllable, ScoredWord } from "../scoring/types.js";
import { PhonemeDetail } from "./PhonemeDetail.js";
import { band } from "./band.js";

interface WordChipsProps {
  words: ScoredWord[];
/**
 * BCP-47 tag for the language being *taught*, e.g. "fr-FR".
 *
 * WCAG 3.1.2 (Language of Parts). Without it a screen reader pronounces
 * French with English phonetics and Devanagari not at all, in a product whose
 * entire purpose is pronunciation — the one place a synthetic voice must get
 * a phrase right. Azure's locale codes are already valid BCP-47 tags, so they
 * pass straight through.
 *
 * Applied only to text genuinely in that language. The prompt, gloss and focus
 * are English instruction *about* the phrase, and tagging those would make a
 * reader speak English in a French voice — worse than leaving them untagged.
 */
  lang?: string;
  /** Tap a syllable to hear that slice of the take — see useSyllablePlayback. */
  onSelectSyllable?: (syllable: ScoredSyllable, index: number) => void;
  /** Offset of the syllable currently sounding, or null. */
  playingOffsetTicks?: number | null;
}

const DETAIL_ID = "phoneme-detail";

/**
 * What to show on the chip instead of a score, where a score would mislead.
 *
 * `Omission` and `Insertion` are facts about *whether* a word was said, and a
 * number cannot express either. Everything else — `None`, `Mispronunciation`,
 * or a type this build has not seen — is a judgement about *how well*, and
 * there the score is the whole point.
 */
function chipMark(word: ScoredWord): { text: string; note: string | null } {
  if (word.errorType === "Omission") {
    // No score. Azure reports 0, and 0 out of 100 is a claim about
    // pronunciation that nothing measured.
    return { text: "—", note: "not said" };
  }
  if (word.errorType === "Insertion") {
    // Said, but not asked for. Scoring it against a phrase it is not in
    // would be scoring the wrong thing.
    return { text: "+", note: "extra" };
  }
  return { text: String(Math.round(word.accuracy)), note: null };
}

function WordChipsBase({ words, lang, onSelectSyllable, playingOffsetTicks }: WordChipsProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const open = openIndex === null ? null : words[openIndex];

  return (
    <>
      <div className="words">
        {words.map((w, i) => {
          const mark = chipMark(w);
          return (
          <button
            key={`${w.word}-${i}`}
            type="button"
            /*
              An omitted word is banded `lo` regardless of its score, and an
              inserted one `mid`. Banding an omission by accuracy is banding a
              number that means nothing; banding an insertion as a failure
              would read as "you said this badly" about a word that is simply
              not in the phrase.
            */
            className={`word ${w.errorType === "Omission" ? "lo" : w.errorType === "Insertion" ? "mid" : band(w.accuracy)}`}
            aria-expanded={openIndex === i}
            // Only ever one PhonemeDetail rendered at a time (below), so this
            // is only meaningful — and only set — for whichever chip is open.
            aria-controls={openIndex === i ? DETAIL_ID : undefined}
            // Capped stagger — beyond the first ~8 chips the extra delay adds
            // nothing but waiting, so later chips just share the last step.
            style={{ animationDelay: `${Math.min(i, 8) * 35}ms` }}
            onClick={() => setOpenIndex(openIndex === i ? null : i)}
          >
            <span lang={lang}>{w.word}</span>
            <small>{mark.text}</small>
            {/*
              Read to a screen reader but not shown: the chip is small and the
              mark already carries it visually, while "not said" is the whole
              meaning for anyone who cannot see that the number is a dash.
            */}
            {mark.note && <span className="sr-only">{mark.note}</span>}
          </button>
          );
        })}
      </div>
      {/* key forces a fresh mount (and re-plays the reveal) on every switch
          between words, not just the first open. */}
      {open && (
        <PhonemeDetail
          key={openIndex}
          word={open}
          id={DETAIL_ID}
          lang={lang}
          {...(onSelectSyllable ? { onSelectSyllable } : {})}
          playingOffsetTicks={playingOffsetTicks ?? null}
        />
      )}
    </>
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
export const WordChips = memo(WordChipsBase);
