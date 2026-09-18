/**
 * "Which sound was in that?" — the options a `locate` activity offers.
 *
 * The model plays the phrase and the learner picks which written syllable it
 * contained. It is the perception half of what every other kind asks for in
 * production, on **the exact unit the scorer reports**: the skills store keys
 * on written syllables like "jour" and "ment", the report names them, the
 * scheduler ranks them — and until now nothing ever asked a learner to
 * recognise one by ear.
 *
 * ── it needs no authored content, and that is the point ────────────────────
 *
 * A `listen` activity needs written near-misses — `poisson` against `poison` —
 * and writing those is the work, which is why they are a field an author
 * fills. This composes its options from `soundTargets` across the language:
 * the answer is a syllable this phrase drills, and the wrong options are
 * syllables **other** phrases drill that this one does not contain.
 *
 * So every language that already has sound targets has this kind for free. It
 * was the one new activity in `docs/PRODUCT-IMPROVEMENTS.md` that needed no
 * phonetician.
 *
 * ── the one way this could be quietly broken ───────────────────────────────
 *
 * A distractor that happens to occur in the phrase is a second right answer,
 * and the learner is marked wrong for hearing correctly. Every candidate is
 * therefore checked against the phrase itself rather than against the
 * activity's own target list — an author who omits a syllable the phrase
 * plainly contains must not turn it into a trap.
 */

import type { Activity, LanguageActivitySet } from "./types.js";

export interface LocateOption {
  grapheme: string;
  correct: boolean;
}

/**
 * How many options a question carries. Four is the board's own shape for a
 * choice of this kind, and it is the number at which guessing is worth 25% —
 * low enough that a right answer means something, high enough that the screen
 * stays scannable on a phone.
 */
export const LOCATE_OPTIONS = 4;

/**
 * Whether a phrase contains a written syllable.
 *
 * Case-folded, because the skills store folds too — "Jour" in a sentence and
 * "jour" in a target list are the same sound and have to compare equal, or a
 * distractor drawn from one would slip past a check against the other.
 */
export function phraseContains(target: string, grapheme: string): boolean {
  return target.toLocaleLowerCase().includes(grapheme.toLocaleLowerCase());
}

/**
 * Composes one question, or returns null when the language cannot support it.
 *
 * Null rather than a short question. Three options where four were intended is
 * a different exercise with different odds, and one option is not a question at
 * all — so a language with too few distinct syllables gets no `locate`
 * activities rather than easy ones.
 *
 * Deterministic for a given activity: the order comes from the activity's own
 * id, so a learner who returns to a question they have seen meets it as they
 * left it, and a test can assert a position. Shuffling per render would also
 * move the answer under a learner's thumb between the audio ending and the tap.
 */
export function locateOptions(
  activity: Activity,
  language: LanguageActivitySet,
): LocateOption[] | null {
  const answer = (activity.soundTargets ?? []).find((grapheme) =>
    phraseContains(activity.target, grapheme),
  );
  // No answer means the authored targets do not occur in the phrase, which the
  // publish gate refuses — but this is read at runtime against served content,
  // so it says no rather than picking one at random.
  if (answer === undefined) return null;

  const candidates = [
    ...new Set(
      language.activities
        .filter((other) => other.id !== activity.id)
        .flatMap((other) => other.soundTargets ?? []),
    ),
  ]
    .filter((grapheme) => !phraseContains(activity.target, grapheme))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  if (candidates.length < LOCATE_OPTIONS - 1) return null;

  // Deterministic, and spread across the candidate list rather than taking the
  // first three: the front of an alphabetical list is not a fair sample of a
  // language's sounds.
  const step = Math.max(1, Math.floor(candidates.length / (LOCATE_OPTIONS - 1)));
  const offset = activity.id % step;
  const chosen: string[] = [];
  for (let i = 0; chosen.length < LOCATE_OPTIONS - 1 && i < candidates.length; i += 1) {
    const pick = candidates[(offset + i * step) % candidates.length];
    if (pick !== undefined && !chosen.includes(pick)) chosen.push(pick);
  }
  if (chosen.length < LOCATE_OPTIONS - 1) return null;

  const options: LocateOption[] = [
    { grapheme: answer, correct: true },
    ...chosen.map((grapheme) => ({ grapheme, correct: false })),
  ];

  // Placed by the activity's id rather than shuffled, so the answer is not
  // always first and the question is stable across renders.
  const at = activity.id % LOCATE_OPTIONS;
  const [correct] = options.splice(0, 1);
  if (correct !== undefined) options.splice(at, 0, correct);

  return options;
}
