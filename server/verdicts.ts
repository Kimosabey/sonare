/**
 * Where our word verdict and Azure's disagree, counted so it can be queried.
 *
 * Two independent judgements of the same take now exist: Azure's per-word
 * `errorType` from miscue detection, and this codebase's own alignment of the
 * reference against the transcript. Storing both is only useful if the
 * disagreement is *findable* — a stored pair of structures nobody diffs is
 * two opinions and no information.
 *
 * So the record carries a small summary rather than leaving a fixture analysis
 * to reconstruct it. The interesting figure is not the total; it is which
 * direction the disagreements run. If Azure reports omissions where the
 * alignment finds the word present, the transcript and the miscue verdict are
 * telling different stories about the same audio. If the alignment finds
 * substitutions where Azure says the word was fine, that is the case Azure has
 * no error type for and the whole reason the alignment exists.
 *
 * Nothing here decides anything for the learner. It is evidence for the
 * fixture run, and deliberately not a score — R3's reasoning applies just as
 * much to a number derived from two verdicts as to one derived from
 * confidence.
 */

import type { Alignment } from "./alignment.js";
import type { PronunciationResult } from "./services/types.js";

export interface VerdictComparison {
  /** Reference words, after the alignment's own tokenisation. */
  expectedWords: number;
  /** Words Azure returned. Not the same count when it heard something else. */
  providerWords: number;

  /** Azure's own tallies, from `errorType`. */
  providerOmissions: number;
  providerInsertions: number;
  providerMispronunciations: number;

  /** Ours, from the alignment. */
  alignedMissing: number;
  alignedSubstituted: number;
  alignedExtra: number;
  alignedRepeated: number;

  /**
   * Signed difference in words called absent: positive means Azure found more
   * omissions than the alignment did.
   */
  omissionDelta: number;

  /**
   * True when one verdict says the take was clean and the other does not.
   *
   * Deliberately *not* a difference in counts. That is what it was, and
   * running it over the 139 real attempts showed why the counts cannot be
   * compared: all ten disagreements were French and all in the same direction,
   * because "allez-vous" is two words to this alignment and one to Azure. The
   * flag was firing on a definitional difference about what a word is — which
   * this module's own tokenisation argues for, since a learner can get
   * "allez" and "vous" separately right or wrong — and burying the cases that
   * actually mattered among artefacts.
   *
   * Whether each side found *any* fault is tokenisation-independent, and it is
   * the question worth asking: one of them thinks the learner said the phrase
   * and the other does not.
   */
  disagrees: boolean;

  /** A take carrying a number we could not compare, so its verdict is partial. */
  numericFormsDiffer: boolean;

  /**
   * Findings the alignment can express and Azure cannot, so their presence is
   * the alignment earning its place rather than merely agreeing.
   */
  providerCannotExpress: number;
}

/** Words Azure marked with a given error type. */
function countErrorType(result: PronunciationResult, errorType: string): number {
  if (result.indeterminate) return 0;
  return result.words.filter((word) => word.errorType === errorType).length;
}

/**
 * Compares the two verdicts for one take.
 *
 * An indeterminate result has no word verdict to compare against, so every
 * provider tally is zero and `disagrees` is false — an unmeasured take is not
 * a disagreement, and counting it as one would make the figure track the
 * indeterminate rate instead of the thing it is meant to measure.
 */
export function compareVerdicts(
  result: PronunciationResult,
  alignment: Alignment,
): VerdictComparison {
  const providerOmissions = countErrorType(result, "Omission");
  const providerInsertions = countErrorType(result, "Insertion");
  const providerMispronunciations = countErrorType(result, "Mispronunciation");
  const providerWords = result.indeterminate ? 0 : result.words.length;

  // Ours counts a dropped word as missing; a substitution is a word that was
  // said, wrongly, so it is not added in here. Azure has no substitution type,
  // which is exactly the asymmetry this figure exposes.
  const omissionDelta = result.indeterminate ? 0 : providerOmissions - alignment.missing;

  /**
   * Word *presence* only, on both sides — the one question both verdicts
   * actually answer.
   *
   * `Mispronunciation` is deliberately excluded. It is a judgement about how
   * well a word was said, and this alignment does not make one: it reads a
   * transcript, so a learner who says every word and mispronounces one is
   * clean by its measure and faulty by Azure's. Counting it made all ten
   * disagreements in the real trail one-directional — "we called it clean,
   * Azure found a fault" — which was not a conflict at all but the two
   * verdicts answering different questions, exactly as designed.
   *
   * Omission and Insertion are Azure's presence verdicts, and those are
   * comparable with ours. The mispronunciation count stays in the record
   * because it is useful; it is just not evidence of a disagreement.
   */
  const providerFoundAbsence = providerOmissions + providerInsertions > 0;
  const weFoundAbsence =
    alignment.missing + alignment.substituted + alignment.extra + alignment.repeated > 0;

  return {
    expectedWords: alignment.tokens.length,
    providerWords,
    providerOmissions,
    providerInsertions,
    providerMispronunciations,
    alignedMissing: alignment.missing,
    alignedSubstituted: alignment.substituted,
    alignedExtra: alignment.extra,
    alignedRepeated: alignment.repeated,
    omissionDelta,
    /**
     * Suppressed where a number defeated the comparison. Neither side is wrong
     * about the audio there — we simply could not check that word, and a flag
     * that fired on it would send someone to read a take with nothing to find.
     */
    disagrees:
      !result.indeterminate &&
      alignment.numericForms === 0 &&
      providerFoundAbsence !== weFoundAbsence,
    numericFormsDiffer: alignment.numericForms > 0,
    providerCannotExpress: alignment.substituted + alignment.repeated,
  };
}
