/**
 * The course-shaped sets — the content that carries a spine.
 *
 * Separate from `LANGUAGES` on purpose, and the separation is the design
 * rather than a staging area:
 *
 * **`LANGUAGES` is the floor.** A flat list per language, no units, no `read`
 * or `recall` rows. It is what a learner with no network and no cache
 * practises, and it is the shape every client built before the spine existed
 * knows how to read. Something has to still *be* that shape for "an old client
 * keeps working" to be checkable.
 *
 * **These are the next published version.** Content is versioned and
 * immutable, so the spine arrives by publishing rather than by rewriting: the
 * bundled documents are untouched, `fr:1` stays exactly as it was, and the
 * course becomes `fr:2`. `npm run seed-content -- --course` is what publishes
 * it, and it is deliberately not the default — see the note there.
 *
 * French and German only. Spanish and Hindi stay flat: they have no spine
 * authored, and hi-IN cannot honestly carry `soundTargets` at all because the
 * provider returns no syllable graphemes for Devanagari (measured: 0 of 7
 * named). A flat set remains valid, publishable content.
 */

import { FRENCH_COURSE } from "./french.js";
import { GERMAN_COURSE } from "./german.js";
import type { LanguageActivitySet } from "../types.js";

/** Every language with a spine authored, in the language picker's order. */
export const COURSES: LanguageActivitySet[] = [FRENCH_COURSE, GERMAN_COURSE];

/**
 * The course set for one language, or undefined where none is authored.
 *
 * Undefined is the normal answer, not a failure: a language with no spine has
 * a working flat set, and every caller falls back to it.
 */
export function getCourse(slug: string | undefined): LanguageActivitySet | undefined {
  return COURSES.find((c) => c.slug === slug);
}
