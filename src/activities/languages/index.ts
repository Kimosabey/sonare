import { FRENCH } from "./french.js";
import { SPANISH } from "./spanish.js";
import { GERMAN } from "./german.js";
import { HINDI } from "./hindi.js";
import type { LanguageActivitySet } from "../types.js";

export const PASS_SCORE = 60;

/** Attempts allowed before the learner may move on without passing. */
export const MAX_ATTEMPTS = 3;

/** Order here is display order on the language picker. */
export const LANGUAGES: LanguageActivitySet[] = [FRENCH, SPANISH, GERMAN, HINDI];

export function getLanguage(slug: string | undefined): LanguageActivitySet | undefined {
  return LANGUAGES.find((l) => l.slug === slug);
}
