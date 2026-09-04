/**
 * What to change on the next attempt, derived from the attempt just made.
 *
 * The activity's own `focus` field ("Nasal vowels /ɔ̃/ and /ɑ̃/, and the
 * liaison in allez-vous") is written for the activity, not for the take: it
 * says exactly the same thing whether the learner scored 41 or 79, and it
 * names sounds in notation most learners cannot read. It answers "what is this
 * exercise about", which is a different question from "what did I just get
 * wrong".
 *
 * Syllables can answer the second one, because they arrive scored and — 83% of
 * the time across the French set — named. Pure and DOM-free so the report can
 * use the same function the activity screen does, and so it is testable
 * without rendering anything.
 */

import type { PronunciationResult, ScoredSyllable } from "../speech/scoring/types.js";

/**
 * Below this a syllable is worth singling out. Matches the word-chip band
 * boundary rather than inventing a third threshold — a syllable shown in warn
 * or fail colours should be the one the advice talks about.
 */
const WEAK_CEILING = 80;

export interface WeakestSyllable {
  syllable: ScoredSyllable;
  /** The word it belongs to, for context the syllable alone cannot give. */
  word: string;
  /** 1-based position within that word, for the unnamed case. */
  position: number;
  countInWord: number;
}

/**
 * The single weakest syllable worth mentioning, or null when there is nothing
 * useful to say.
 *
 * Deliberately one, not a list. A learner about to re-record can hold one
 * thing in mind; three is a report, and the report already exists.
 */
export function weakestSyllable(result: PronunciationResult): WeakestSyllable | null {
  if (result.indeterminate) return null;

  let worst: WeakestSyllable | null = null;

  for (const word of result.words) {
    const syllables = word.syllables ?? [];
    syllables.forEach((syllable, index) => {
      if (syllable.accuracy >= WEAK_CEILING) return;
      if (worst && worst.syllable.accuracy <= syllable.accuracy) return;
      worst = {
        syllable,
        word: word.word,
        position: index + 1,
        countInWord: syllables.length,
      };
    });
  }

  return worst;
}

/**
 * One sentence a learner can act on, or null.
 *
 * Two shapes, because a whole language only ever gets the second: Hindi
 * returns no graphemes at all (0 of 108 measured), so naming the syllable is
 * impossible there and its position is the only handle available. Both are
 * real advice; neither is a degraded version of the other.
 *
 * The wording avoids phonetic notation entirely. "Try 'ment' on its own,
 * slowly" is something a learner can do; "/mɑ̃/ needs work" is something they
 * would have to decode first.
 */
export function adviceFor(result: PronunciationResult): string | null {
  const weakest = weakestSyllable(result);
  if (!weakest) return null;

  const score = Math.round(weakest.syllable.accuracy);

  if (weakest.syllable.grapheme) {
    return `Weakest sound: “${weakest.syllable.grapheme}” in “${weakest.word}”, at ${score}. Try that part on its own, slowly, then the whole phrase again.`;
  }

  return `Weakest sound: part ${weakest.position} of ${weakest.countInWord} in “${weakest.word}”, at ${score}. Tap it below to hear how you said it.`;
}
