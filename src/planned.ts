/**
 * What is planned but not here yet, in a learner's words.
 *
 * A "coming soon" is a promise, and this product is unusually careful about
 * claims — it refuses to show a score it did not measure, a count it cannot
 * check, or a figure about a child it has no right to. A roadmap on a screen
 * is the same kind of claim pointed at the future, so it gets the same
 * treatment:
 *
 * **No dates.** Not a month, not a quarter, not "soon". A date is the part of
 * a promise that can be broken while the feature is still being built, and the
 * only thing it buys is pressure. `planned.test.ts` refuses one.
 *
 * **Only decisions, never hopes.** Every entry here is something already
 * settled — the work is scheduled or the content is commissioned. An idea
 * somebody likes is not an entry; it is an idea, and putting it here spends
 * trust on something that may never happen.
 *
 * **What it does for the learner, not what we will build.** "German and
 * Hindi" rather than "expand the language catalogue". A learner reading this
 * is deciding whether to wait, and can only decide on the first.
 *
 * Removing an entry is how one ships. There is no "done" state here, because
 * a list of things that have already arrived is a changelog, and a changelog
 * belongs somewhere a learner is not trying to practise.
 */

export interface PlannedFeature {
  /** What a learner will be able to do. Their words, not the codebase's. */
  title: string;
  /** Why it is not here yet, honestly. One sentence, no excuses. */
  because: string;
}

export const PLANNED: readonly PlannedFeature[] = [
  {
    title: "German and Hindi",
    because:
      "Both are written and waiting. Hindi needs one thing first: the scorer names the sounds it hears in French and Spanish, and for Hindi it names none — so there would be a score and nothing to act on.",
  },
  {
    title: "The vowel chart, for every voice",
    because:
      "It measures where your vowel sat, and the method it uses is only accurate for lower-pitched voices — so it refuses rather than showing you a wrong one. Making it work for higher voices is a harder problem than it looks and is being worked on.",
  },
  {
    title: "Hearing a difference before you have to say it",
    because:
      "Telling poisson from poison by ear, before being asked to produce the difference. It needs pairs written by somebody who knows the language's sounds, which is being arranged.",
  },
];
