/** T12/FR-22 — per-word chips, coloured by accuracy. Tapping opens FR-23. */

import { memo, useState } from "react";
import type { ScoredWord } from "../scoring/types.js";
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
}

const DETAIL_ID = "phoneme-detail";

function WordChipsBase({ words, lang }: WordChipsProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const open = openIndex === null ? null : words[openIndex];

  return (
    <>
      <div className="words">
        {words.map((w, i) => (
          <button
            key={`${w.word}-${i}`}
            type="button"
            className={`word ${band(w.accuracy)}`}
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
            <small>{Math.round(w.accuracy)}</small>
          </button>
        ))}
      </div>
      {/* key forces a fresh mount (and re-plays the reveal) on every switch
          between words, not just the first open. */}
      {open && <PhonemeDetail key={openIndex} word={open} id={DETAIL_ID} lang={lang} />}
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
