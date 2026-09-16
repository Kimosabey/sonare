import { FRENCH } from "./french.js";
import { SPANISH } from "./spanish.js";
import { GERMAN } from "./german.js";
import { HINDI } from "./hindi.js";
import type { LanguageActivitySet } from "../types.js";

export const PASS_SCORE = 60;

/** Attempts allowed before the learner may move on without passing. */
export const MAX_ATTEMPTS = 3;

/** Order here is display order on the language picker. */
/**
 * The languages this product offers — the MVP scope: French and Spanish.
 *
 * German and Hindi are still written and still imported, so nothing is lost
 * and re-adding either is one entry in this array. They are not listed because
 * offering a language is a promise: a picker entry leads to content, a course,
 * a model voice and a scoring locale, and a learner who starts one expects the
 * rest of the product to follow.
 *
 * Hindi in particular is worth naming. The provider returns **no syllable
 * names at all** for hi-IN — 0 of 108 graphemes across its ten targets — so a
 * Hindi learner's entire per-syllable experience is positional labels, which
 * is the one language where this product's core claim degrades rather than
 * being delivered.
 */
export const LANGUAGES: LanguageActivitySet[] = [FRENCH, SPANISH];

/**
 * Every set that has been authored, offered or not.
 *
 * The distinction against `LANGUAGES` is the point. *Offered* is a product
 * decision — what the picker leads to, what the MVP promises. *Authored* is
 * what exists and therefore what content rules still apply to: a phrase that
 * breaks at phone width, or a Devanagari target quietly transliterated into
 * Latin, is wrong in a set that is one array entry from shipping just as much
 * as in one that ships today.
 *
 * So screens read `LANGUAGES`, and tests about the quality of the writing read
 * this. Without the split, taking a language out of the product would silently
 * take its content rules out with it — which is exactly when nobody is looking.
 */
export const AUTHORED_SETS: LanguageActivitySet[] = [FRENCH, SPANISH, GERMAN, HINDI];

export function getLanguage(slug: string | undefined): LanguageActivitySet | undefined {
  return LANGUAGES.find((l) => l.slug === slug);
}
