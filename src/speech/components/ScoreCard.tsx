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
  /**
   * True when the capture layer measured clear speech in this take. Lets an
   * indeterminate result say which of two very different things happened —
   * see the copy below.
   */
  heardSpeech?: boolean;
}

/**
 * Azure returns the same shape for "there was no speech" and "there was
 * speech but none of it matched the target phrase": every word Omission, no
 * phonemes. Recorded evidence for why the difference matters — one speaker,
 * one session, one microphone:
 *
 *   hi-IN (fluent)   full recognition, scored 93.4 / 96.4 / 99.4
 *   fr-FR (learning) "Je voudrais." out of a nine-word phrase, scored 23.2
 *
 * Told only "couldn't get a clear read", that speaker reasonably went hunting
 * for a microphone fault — as did the debugging session that produced these
 * numbers. The audio was flawless. The message was wrong, and it sent
 * everyone in the wrong direction for hours.
 */
const NO_SPEECH_COPY = "Couldn't get a clear read — try again.";
const NO_MATCH_COPY = "We heard you clearly, but couldn't match it to this phrase.";
const NO_MATCH_HINT =
  "That usually means a few sounds are far enough off that the scorer lost the thread. Try it a little slower, one word at a time.";

export function ScoreCard({ result, heardSpeech = false }: ScoreCardProps) {
  if (result.indeterminate) {
    // The provider found nothing to assess. Whether that means silence or an
    // unmatchable utterance is something only the capture layer knows.
    const noMatch = heardSpeech;
    return (
      <div className="verdict v-warn">
        <div className="tag">{noMatch ? "NO MATCH" : "UNCLEAR"}</div>
        <div>
          {noMatch ? NO_MATCH_COPY : NO_SPEECH_COPY}
          <div className="hint">{noMatch ? NO_MATCH_HINT : result.reason}</div>
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
