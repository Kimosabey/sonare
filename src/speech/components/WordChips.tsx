/** T12/FR-22 — per-word chips, coloured by accuracy. Tapping opens FR-23. */

import { useState } from "react";
import type { ScoredWord } from "../scoring/types.js";
import { PhonemeDetail } from "./PhonemeDetail.js";
import { band } from "./band.js";

interface WordChipsProps {
  words: ScoredWord[];
}

export function WordChips({ words }: WordChipsProps) {
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
            onClick={() => setOpenIndex(openIndex === i ? null : i)}
          >
            {w.word}
            <small>{Math.round(w.accuracy)}</small>
          </button>
        ))}
      </div>
      {open && <PhonemeDetail word={open} />}
    </>
  );
}
