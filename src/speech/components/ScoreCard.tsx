/**
 * T12/T14 — the result view.
 *
 * R8/FR-24: when the scorer returns nothing usable this renders as words only.
 * No number, no bar, no partial credit. A fabricated score is worse than an
 * honest "couldn't get a clear read", because a learner cannot tell the two
 * apart and will act on the number.
 */

import type { PronunciationResult } from "../scoring/types.js";
import { WordChips } from "./WordChips.js";
import { AnimatedCell } from "./AnimatedCell.js";

interface ScoreCardProps {
  result: PronunciationResult;
}

export function ScoreCard({ result }: ScoreCardProps) {
  if (result.indeterminate) {
    return (
      <div className="verdict v-warn">
        <div className="tag">UNCLEAR</div>
        <div>
          Couldn&rsquo;t get a clear read — try again.
          <div className="hint">{result.reason}</div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="overall">
        <AnimatedCell value={result.overall} label="overall" />
        <AnimatedCell value={result.accuracy} label="accuracy" />
        <AnimatedCell value={result.fluency} label="fluency" />
        <AnimatedCell value={result.completeness} label="complete" />
      </div>

      {/* PRD §6: prosody is optional — many languages never return it. */}
      {result.prosody !== undefined && (
        <p className="hint">prosody {Math.round(result.prosody)}</p>
      )}

      {result.recognized && <p className="hint">Heard: &ldquo;{result.recognized}&rdquo;</p>}

      {result.words.length > 0 && <WordChips words={result.words} />}
    </>
  );
}
