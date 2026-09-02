/** T13/FR-23 — the phonemes behind one word, with its error type. */

import type { ScoredWord } from "../scoring/types.js";
import { band } from "./band.js";
import { memo } from "react";

interface PhonemeDetailProps {
  word: ScoredWord;
  id?: string;
}

function PhonemeDetailBase({ word, id }: PhonemeDetailProps) {
  // Azure labels phonemes for en-* but returns empty labels for fr-FR and other
  // non-English locales. The scores are still real, so show them positionally
  // rather than rendering a row of blanks.
  const unlabeled = word.phonemes.length > 0 && word.phonemes.every((p) => !p.phoneme);

  return (
    <div className="phonemes" id={id}>
      {word.phonemes.length === 0 ? (
        <span>no phoneme detail returned for this word</span>
      ) : (
        word.phonemes.map((p, i) => (
          <span key={`${p.phoneme}-${i}`} className={`p ${band(p.accuracy)}`}>
            {p.phoneme || `sound ${i + 1}`} <b>{Math.round(p.accuracy)}</b>
          </span>
        ))
      )}

      {unlabeled && (
        <div style={{ marginTop: 8, color: "var(--dim)" }}>
          This language returns per-sound scores without labels, so sounds are numbered in order.
        </div>
      )}
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
