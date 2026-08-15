/** T13/FR-23 — the phonemes behind one word, with its error type. */

import type { ScoredWord } from "../scoring/types.js";
import { band } from "./band.js";

interface PhonemeDetailProps {
  word: ScoredWord;
}

export function PhonemeDetail({ word }: PhonemeDetailProps) {
  // Azure labels phonemes for en-* but returns empty labels for fr-FR and other
  // non-English locales. The scores are still real, so show them positionally
  // rather than rendering a row of blanks.
  const unlabeled = word.phonemes.length > 0 && word.phonemes.every((p) => !p.phoneme);

  return (
    <div className="phonemes">
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
