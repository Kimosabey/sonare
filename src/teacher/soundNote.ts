/**
 * Turning the difficulty table into the note a teacher reads.
 *
 * Both halves of this already existed and nothing joined them. `difficulty.ts`
 * has held per-sound advice for every shipped language since it was written —
 * what an English speaker substitutes, and what to do about it — and
 * `SoundDetail` has had a `note` prop for as long as it has existed. Nobody
 * ever passed one. A teacher opening a sound got the distribution and the
 * words it was heard in, and no guidance at all, on the screen whose whole
 * purpose is telling them what to do about it.
 *
 * The same shape as `locate` shipping in no course, or the vowel chart nothing
 * imported: each piece tested, the join absent, and invisible to every test
 * that asks whether a piece works.
 *
 * ## Why the two fields say different things
 *
 * `howItIsMade` is the action — what a mouth has to do. It is the advice
 * verbatim, because that is what the table was written to hold and rewriting
 * it here would make two versions of the same sentence.
 *
 * `inTheRoom` is what a teacher will actually hear, built from the
 * substitution. A teacher who knows only that a sound is hard listens for
 * *wrongness*; one who knows which wrong sound is coming can name it the
 * moment it arrives, which is the difference between "not quite" and "you are
 * using the English r there".
 *
 * ## L1 is English, and that is a stated limit rather than an oversight
 *
 * `difficulty.ts` is keyed by first language, and only `en` is written,
 * because every gloss, prompt and instruction in the product is in English. A
 * learner who does not read English cannot use the app at all, so a second L1
 * is a translation project rather than a row in a table.
 */

import { L1_DIFFICULTY, adviceForGrapheme } from "../activities/difficulty.js";
import type { SoundNote } from "../components/SoundDetail.js";

/** The only first language the product currently assumes. See the header. */
const L1 = "en";

/**
 * Accepts a locale or a bare language subtag, and answers with the locale the
 * table is keyed by.
 *
 * The class response carries `slug` — "fr" — and the difficulty table is keyed
 * by pair, "en→fr-FR". The first version of this trusted the caller to resolve
 * one to the other, and the caller could not always do it: `resolveLanguage`
 * answers from served content, which is absent in a test and on a cold start.
 * Every note came back null, and a null note renders nothing, so the screen
 * looked exactly as it had when the prop was never passed at all — the same
 * silence as the bug this whole module exists to fix, arrived at from a
 * different direction.
 *
 * Matching here rather than demanding a locale, because the failure is silent
 * and the fix is three lines. An exact key wins; otherwise the first table
 * whose locale is that language.
 */
function tableLocaleFor(given: string): string {
  const wanted = given.trim();
  if (wanted === "") return wanted;

  const keys = Object.keys(L1_DIFFICULTY);
  const exact = keys.find((key) => key === `${L1}\u2192${wanted}`);
  if (exact !== undefined) return wanted;

  const base = wanted.split("-")[0] ?? wanted;
  for (const key of keys) {
    const locale = key.split("\u2192")[1] ?? "";
    if (locale.split("-")[0] === base) return locale;
  }
  return wanted;
}

/**
 * The note for one sound, or null when the table has nothing for it.
 *
 * Null rather than a placeholder, deliberately. A sound with no entry is one
 * nobody has written guidance for, and inventing a sentence to fill the space
 * would put advice on screen that no one stands behind — on a screen a teacher
 * is about to act on. `SoundDetail` renders nothing for a null note, which is
 * the honest state.
 */
export function soundNoteFor(targetLocale: string, grapheme: string): SoundNote | null {
  const entry = adviceForGrapheme(L1, tableLocaleFor(targetLocale), grapheme);
  if (entry === null) return null;

  return {
    howItIsMade: entry.advice,
    inTheRoom: `Most will reach for ${entry.substitution}. That is the substitution to listen for.`,
  };
}
