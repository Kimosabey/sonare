/**
 * Which sounds are hard, for whom, and what to do about it. Pure data.
 *
 * N7. The product scores every learner the same way, and that is correct — the
 * provider hears what was said, not who said it. What differs is **what a
 * learner is likely to have said instead**, and that depends on the language
 * they already speak: an English speaker's French /ʁ/ comes out as an English
 * r, a Spanish /r/ comes out as an English one, and the advice for each is
 * different and specific.
 *
 * ## The pair, not the language
 *
 * Keyed by `L1 → target locale`, because difficulty is a relationship. The
 * Castilian θ is hard for a Spanish-speaking learner of English and trivial for
 * an English speaker, who already has it in "think". A table keyed by target
 * language alone would be asserting a difficulty about nobody in particular.
 *
 * Only `en` is written, because English is the only first language the product
 * currently assumes — every gloss, prompt and instruction is in English, so a
 * learner who does not read it cannot use the app at all. Adding a second L1
 * is a translation project, not a row here.
 *
 * ## What this is not
 *
 * It is not a scoring input. Nothing here changes a number, weights a
 * threshold or excuses a take — the provider's assessment is the score (R3),
 * and a per-L1 adjustment would be exactly the "grade on a curve by accent"
 * that T19 exists to investigate rather than to assume.
 *
 * It is advice, and it is **authored**: every substitution and every line of
 * advice below is a claim about phonetics that a linguist should check. The
 * completeness of the table is machine-checkable (see difficulty.test.ts) and
 * its correctness is not.
 */

/** A sound a learner of one first language reliably gets wrong in another. */
export interface SoundDifficulty {
  /**
   * The written syllables this is about, as they appear in the content's
   * `soundTargets` — which is what the scorer can actually name, and therefore
   * the only handle a screen could join on.
   */
  graphemes: string[];
  /** The target sound, in IPA, for anyone reading this who wants precision. */
  ipa: string;
  /** What a speaker of this L1 tends to produce instead. */
  substitution: string;
  /** What to try. One sentence, actionable, no phonetic vocabulary required. */
  advice: string;
}

/** `${l1}→${targetLocale}`, e.g. `en→fr-FR`. */
export type LanguagePair = string;

export function pairKey(l1: string, targetLocale: string): LanguagePair {
  return `${l1}→${targetLocale}`;
}

/**
 * The table. Draft — see the file comment.
 *
 * Graphemes are lower case, matching how the skills store keys and how
 * `readActivity` folds `soundTargets`. Each entry names syllables that occur in
 * the shipped content, which is what the completeness test checks: a
 * difficulty nothing drills is advice a learner can never be given.
 */
export const L1_DIFFICULTY: Readonly<Record<LanguagePair, readonly SoundDifficulty[]>> = {
  "en→fr-FR": [
    {
      graphemes: ["jour", "ris", "mer", "rrière", "ron", "très"],
      ipa: "/ʁ/",
      substitution: "the English r, made with the tongue tip curled back",
      advice:
        "Leave the tongue tip down behind your bottom teeth and make the sound at the back, almost a gargle.",
    },
    {
      graphemes: ["bon", "chan", "main", "tin", "lent", "dans", "ment"],
      ipa: "/ɑ̃/, /ɛ̃/",
      substitution: "the vowel followed by a separate n, as in English “bon-n”",
      advice: "Let the air go through your nose on the vowel itself and stop before any n sound.",
    },
    {
      graphemes: ["deux", "peux", "neuf", "heure"],
      ipa: "/ø/, /œ/",
      substitution: "the English “uh”, made with the lips unrounded",
      advice: "Round your lips as if for “oo” while keeping the tongue forward as for “ay”.",
    },
    {
      graphemes: ["té", "née", "rée"],
      ipa: "/e/",
      substitution: "the English “ay”, which slides into a y at the end",
      advice: "Hold the vowel still — it should not move or end in a y.",
    },
    {
      graphemes: ["coup", "vou", "où", "trouve"],
      ipa: "/u/",
      substitution: "the English “oo”, which starts further forward",
      advice: "Push the lips right forward and keep the tongue back.",
    },
  ],
  "en→es-ES": [
    {
      graphemes: ["rro", "rre", "rros"],
      ipa: "/r/",
      substitution: "a single English r",
      advice:
        "Let the tongue tip bounce off the ridge behind your teeth more than once — it is a flutter, not one contact.",
    },
    {
      graphemes: ["vor", "ren", "tir", "par", "gra", "tro", "gros"],
      ipa: "/ɾ/",
      substitution: "the same English r used for the trilled one",
      advice: "One quick tap of the tongue, close to the d in American “ladder”.",
    },
    {
      graphemes: ["cer", "cia", "za", "ciu", "ce", "cio", "cues", "cuán"],
      ipa: "/θ/",
      substitution: "an s, which is the Latin American pronunciation rather than the Castilian",
      advice: "Put the tongue tip between your teeth, as in the English “think”.",
    },
    {
      graphemes: ["je", "ba"],
      ipa: "/x/",
      substitution: "an English h, which is too soft",
      advice: "Make it further back, with friction — closer to the ch in “loch”.",
    },
    {
      graphemes: ["ño", "ñol"],
      ipa: "/ɲ/",
      substitution: "a plain n followed by a y",
      advice: "One sound, not two: the middle of the tongue meets the roof of the mouth.",
    },
    {
      graphemes: ["ve", "bue"],
      ipa: "/β/",
      substitution: "a hard English v or b",
      advice: "Bring the lips close without quite touching, so the air keeps moving.",
    },
  ],
};

/** The difficulties recorded for one pair, or an empty list if none are. */
export function difficultiesFor(l1: string, targetLocale: string): readonly SoundDifficulty[] {
  return L1_DIFFICULTY[pairKey(l1, targetLocale)] ?? [];
}

/**
 * The advice for one written syllable, or null when none is recorded.
 *
 * Null is the common answer and not a gap to be filled with something generic:
 * most syllables are not *difficult*, they are simply syllables, and a line of
 * advice attached to one a learner already says well is noise that makes the
 * real advice harder to find.
 */
export function adviceForGrapheme(
  l1: string,
  targetLocale: string,
  grapheme: string,
): SoundDifficulty | null {
  const wanted = grapheme.trim().toLocaleLowerCase();
  return (
    difficultiesFor(l1, targetLocale).find((entry) => entry.graphemes.includes(wanted)) ?? null
  );
}
