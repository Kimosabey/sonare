/**
 * Turning one scored take into a learner's durable sound history.
 *
 * The attempt trail expires. `attempts` carries a 90-day TTL because it holds
 * the spoken phrase, the device context and a session id — telemetry, and
 * privacy-sensitive telemetry at that. But the syllable accuracies inside it
 * are the learner's own record, and the product's one distinctive claim ("‑ent
 * is at 61, up from 48 last week") is built on having them for longer than
 * ninety days.
 *
 * So the useful part is extracted at scoring time and merged into `skills`,
 * which has no TTL. That splits retention by purpose: we stop keeping the
 * take, and the learner keeps the history. It also means the sound history no
 * longer depends on the client pushing it — a learner who never syncs still
 * accumulates one, and the merge is a union deduplicated on timestamp so both
 * paths writing the same take is a no-op rather than a double count.
 *
 * Pure and I/O-free, so the extraction rules are testable without a database.
 */

import { logger } from "../logger.js";
import { readSkill, type Skill, type SkillState } from "./merge.js";
import type { PronunciationResult } from "../services/types.js";

/**
 * Language code to content slug.
 *
 * Explicit for what ships, rather than assuming the slug is the primary
 * subtag. It happens to be, for all four — and it stops being true the moment
 * two variants of one language ship, since pt-BR and pt-PT would collapse into
 * one history describing neither. The fallback still guesses the subtag so a
 * new language is not silently dropped, but it says so, because a wrong guess
 * here pools two learners' different sounds together.
 */
const SLUG_BY_CODE: Record<string, string> = {
  "fr-fr": "fr",
  "es-es": "es",
  "de-de": "de",
  "hi-in": "hi",
  "en-us": "en",
};

export function slugForLanguage(code: string): string | null {
  const known = SLUG_BY_CODE[code.trim().toLowerCase()];
  if (known !== undefined) return known;

  const subtag = /^([a-z]{2,3})(?:[-_]|$)/i.exec(code.trim());
  if (subtag?.[1] === undefined) return null;

  const guess = subtag[1].toLowerCase();
  logger.warn(
    { code, guess },
    "[rollup] no slug mapped for this language — guessing the primary subtag",
  );
  return guess;
}

/**
 * The syllables worth keeping from one take, or null when there are none.
 *
 * Returns null rather than an empty state so a caller cannot write a document
 * that says "this learner has no sounds", which is different from having
 * nothing to add.
 */
export function rollupSkills(
  result: PronunciationResult,
  language: string,
  at: string,
): SkillState | null {
  /**
   * An indeterminate take has no scores to keep. R8 makes that the honest
   * answer, and rolling anything up from it would be inventing a measurement
   * for audio the system explicitly declined to judge.
   */
  if (result.indeterminate) return null;

  const slug = slugForLanguage(language);
  if (slug === null) return null;

  /**
   * Pooled by grapheme within the take before merging, so a phrase containing
   * the same syllable twice contributes both readings rather than one silently
   * winning. They share the take's timestamp, so the union would otherwise
   * deduplicate them against each other — the index disambiguates without
   * pretending they happened at different moments.
   */
  const collected: Skill[] = [];
  let index = 0;

  for (const word of result.words ?? []) {
    for (const syllable of word.syllables ?? []) {
      // Validated through the same reader the sync path uses, so an unnamed
      // grapheme is dropped here for the same reason and by the same rule.
      const skill = readSkill({
        grapheme: syllable.grapheme,
        samples: [{ at: index === 0 ? at : bumped(at, index), accuracy: syllable.accuracy }],
      });
      if (skill !== null) {
        collected.push(skill);
        index += 1;
      }
    }
  }

  if (collected.length === 0) return null;

  // Folded through the domain merge so repeated graphemes combine by the same
  // rule everything else uses, rather than a second implementation here.
  return collected.reduce<SkillState>(
    (state, skill) => ({
      slug,
      skills: mergeInto(state.skills, skill),
    }),
    { slug, skills: [] },
  );
}

/**
 * A distinct timestamp per syllable within one take.
 *
 * Milliseconds, so two syllables of the same phrase are ordered as they were
 * spoken and neither is dropped as a duplicate. Deliberately derived from the
 * take's own time rather than `Date.now()`, so re-rolling the same attempt
 * produces the same timestamps and the union stays idempotent.
 *
 * One consequence, recorded because it surprised a test: since a timestamp is
 * a sample's identity, two *separate* takes landing in the same millisecond
 * collapse into one. Harmless in reality — a take needs a recording and a
 * provider round trip, so consecutive ones are seconds apart — but it does
 * mean a test that scores in a tight loop accumulates one sample, not several.
 */
function bumped(at: string, index: number): string {
  const base = new Date(at).getTime();
  if (Number.isNaN(base)) return at;
  return new Date(base + index).toISOString();
}

function mergeInto(skills: Skill[], incoming: Skill): Skill[] {
  const existing = skills.find((s) => s.grapheme === incoming.grapheme);
  if (existing === undefined) return [...skills, incoming];
  return skills.map((s) =>
    s.grapheme === incoming.grapheme
      ? { grapheme: s.grapheme, samples: [...s.samples, ...incoming.samples] }
      : s,
  );
}
