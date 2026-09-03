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
import { memo } from "react";

interface ScoreCardProps {
  result: PronunciationResult;
  /**
   * True when the capture layer measured clear speech in this take. Lets an
   * indeterminate result say which of two very different things happened —
   * see the copy below.
   */
  heardSpeech?: boolean;
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
  /**
   * The learner's best accuracy on this activity *before* this attempt, when
   * there was one. Applied to the accuracy cell alone, because that is the
   * figure `best` tracks and the gate uses — animating overall or fluency
   * from it would compare two different numbers and imply a gain that was
   * never measured.
   */
  previousBest?: number | null;
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

function ScoreCardBase({ result, heardSpeech = false, lang, previousBest }: ScoreCardProps) {
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
        <AnimatedCell
          value={result.accuracy}
          label="accuracy"
          {...(previousBest === null || previousBest === undefined ? {} : { from: previousBest })}
        />
        <AnimatedCell value={result.fluency} label="fluency" />
        <AnimatedCell value={result.completeness} label="complete" />
      </div>

      {/* PRD §6: prosody is optional — many languages never return it. */}
      {result.prosody !== undefined && (
        <p className="hint">prosody {Math.round(result.prosody)}</p>
      )}

      {result.recognized && (
        <p className="hint">
          Heard: &ldquo;<span lang={lang}>{result.recognized}</span>&rdquo;
        </p>
      )}

      {result.words.length > 0 && <WordChips words={result.words} lang={lang} />}
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
export const ScoreCard = memo(ScoreCardBase);
