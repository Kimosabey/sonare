/**
 * Where a pupil stands on one sound, as a word rather than a number.
 *
 * This is the only place an accuracy becomes something a teacher can see, and
 * the conversion is one-way on purpose. The Teacher board's rule is that no
 * pronunciation figure about an identified pupil reaches a class view; keeping
 * the threshold here means the figure stops at this function and a standing is
 * all that travels.
 *
 * The thresholds are `STRONG` and `WEAK` from the scheduler, not new ones.
 * They already encode this product's judgement about what "said well" means
 * and they already drive what a learner is offered next — a second pair tuned
 * for the teacher's screen would let a class look like it was holding a sound
 * the scheduler still considered due.
 *
 * `SoundStanding` is duplicated from `src/teacher/classSummary.ts` rather than
 * imported, following PRD §6 and the same deliberate duplication the content
 * types already have across this boundary: a page cannot import from
 * `server/`, and `server/` does not reach into `src/`.
 */

import { STRONG, WEAK, strengthOf } from "./scheduler.js";
import type { Skill } from "./merge.js";

export type SoundStanding = "just-started" | "getting-there" | "holding";

/**
 * The pupil's standing on this sound, or `null` if they have not reached it.
 *
 * Null rather than "just-started" for no samples, and the distinction is the
 * one the class summary depends on. `strengthOf` returns 0 for an empty list
 * and its own comment warns that callers must not read that as "said badly" —
 * a pupil who has never attempted a sound is not a pupil struggling with it,
 * and counting them as one would inflate the figure a teacher plans a lesson
 * from by everyone who has not got there yet.
 */
export function standingOf(skill: Skill): SoundStanding | null {
  if (skill.samples.length === 0) return null;

  const strength = strengthOf(skill.samples);
  if (strength >= STRONG) return "holding";
  if (strength >= WEAK) return "getting-there";
  return "just-started";
}

/** Every sound this pupil has reached, keyed by grapheme. */
export function standingsFor(skills: readonly Skill[]): Record<string, SoundStanding> {
  const standings: Record<string, SoundStanding> = {};
  for (const skill of skills) {
    const standing = standingOf(skill);
    if (standing !== null) standings[skill.grapheme] = standing;
  }
  return standings;
}

/** How many takes are recorded per sound — a volume, not a verdict. */
export function takesFor(skills: readonly Skill[]): Record<string, number> {
  const takes: Record<string, number> = {};
  for (const skill of skills) {
    if (skill.samples.length > 0) takes[skill.grapheme] = skill.samples.length;
  }
  return takes;
}
