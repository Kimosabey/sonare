/**
 * Building the question a `listen` activity asks. Pure, no React, no DOM.
 *
 * The model says the phrase, and the learner picks **what it meant** — board
 * 1i, "Pick the meaning". The options are English; the French is revealed
 * afterwards, with a note on what separated it from the near miss.
 *
 * ## Why the meaning and not the spelling
 *
 * The first version of this asked which *written form* had been said —
 * `poisson` against `poison`. It was answerable from the spelling alone. A
 * learner who never pressed play could read the two options, notice which one
 * matched the phrase they had been shown, and be right every time; the audio
 * was decoration. Choosing between meanings cannot be shortcut that way,
 * because nothing on screen is in the language being played.
 *
 * The wrong options are **authored** either way — see `distractors` on
 * `Activity` — because a random other meaning is ruled out before the audio
 * finishes and teaches nothing. "A coffee" against "a coffee and a croissant"
 * turns on one word the learner has to actually hear.
 *
 * Lives in `src/activities/` with the content it reads, which is a DOM-free
 * zone (`tsconfig.scripts.json` includes it so Node scripts can import the
 * sets). Nothing here reaches for a clock, a random source or storage, which
 * is also why the option order is derived rather than shuffled.
 */

import type { Activity } from "./types.js";

export interface ListenOption {
  /**
   * Identifies the option within the activity, and survives the rotation below
   * — which is the point, since the rotation is what stops the answer always
   * being first. The correct option is named rather than numbered, so it can
   * be recognised in a record without re-deriving it from content.
   *
   * A distractor's id *is* its authored position, and the honest caveat is
   * that republishing with the near-misses reordered changes what `d0` refers
   * to. What that cannot do is rewrite a learner's history: `ChosenAttempt`
   * stores `correct` alongside `choice`, frozen at the moment they answered,
   * so the judgement never gets re-derived from content that has since moved.
   * The id is for reading back *which* near-miss fooled them, and that is a
   * question about the content version it was asked from.
   */
  id: string;
  /** What the learner reads on the option — an English meaning. */
  text: string;
  correct: boolean;
}

/** The id given to the one true option, distinct from every `d<n>`. */
export const TARGET_OPTION_ID = "target";

/**
 * The options to offer, or an empty list when the activity cannot be asked.
 *
 * Empty rather than partial, in two cases, and both are content the publish
 * gate refuses — this is the second line for the sets that ship in the bundle
 * and never pass through it:
 *
 *  - **No distractors.** One option is not a question; it is a button that is
 *    always right, and a learner who taps it has been told nothing.
 *  - **A distractor equal to the gloss.** Two identical options, one marked
 *    wrong. A learner who picks the right meaning and is told they are wrong
 *    learns the opposite of the lesson.
 *
 * A caller must treat an empty list as "do not ask this", which is why it is
 * empty rather than a single correct option — a signal that cannot be rendered
 * by accident.
 */
export function listenOptions(activity: Activity): ListenOption[] {
  const distractors = activity.distractors ?? [];
  if (distractors.length === 0) return [];
  // Compared against the gloss, because the gloss is the right answer here.
  if (distractors.some((text) => text === activity.gloss)) return [];

  const all: ListenOption[] = [
    { id: TARGET_OPTION_ID, text: activity.gloss, correct: true },
    ...distractors.map((text, index) => ({ id: `d${String(index)}`, text, correct: false })),
  ];

  /**
   * Rotated by the activity's id rather than shuffled.
   *
   * The correct answer must not always be first — a learner would notice
   * within a lesson and stop listening, which defeats the exercise. But it
   * also must not move between renders: a list that reshuffles when the
   * component re-renders moves the option under a learner's finger, and one
   * that reshuffles on retry hands them elimination for free.
   *
   * A rotation is deterministic, needs no seeded generator, and is obviously
   * a permutation — it cannot drop or duplicate an option, which a
   * hand-rolled shuffle can and has elsewhere. What it does not provide is
   * unpredictability across activities: the answer sits at index
   * `id % options.length` and a determined learner could work that out. That
   * is an acceptable trade for a two-to-four option question, where guessing
   * is already cheap and the cost of guessing wrong is a spent try.
   */
  const offset = activity.id % all.length;
  return [...all.slice(offset), ...all.slice(0, offset)];
}

/** Whether a recorded choice was the right one, by id. */
export function isCorrectChoice(activity: Activity, choiceId: string): boolean {
  return listenOptions(activity).some((option) => option.id === choiceId && option.correct);
}
