/**
 * French Activity Test — a guided sequence of pronunciation activities that
 * unlock one at a time, ending in a performance report.
 *
 * Separate from the drill and the fixture runner on purpose: the drill is
 * single-shot practice, the fixture is measurement, and this is a *session*
 * with progress and a verdict. It reuses the same capture and scoring path, so
 * it inherits R8 (indeterminate is never a number) for free.
 */

import type { PronunciationResult } from "../speech/scoring/types.js";

/**
 * The four things an activity can ask of a learner.
 *
 * Exported as a list rather than only as a union, so the runtime validators
 * check against the same source the type is derived from. The client carried
 * two hand-written copies of `repeat | respond | read` — one as the union, one
 * in src/content/cache.ts — and those are now one list. The server store keeps
 * its own copy on purpose (PRD §6: a page cannot import from `server/`, and
 * the store must not import from `src/`).
 *
 * A kind no screen can render is not a type error and not a failed request: it
 * is a blank task. That is why publishing checks against this list rather than
 * merely for a non-empty string.
 *
 *  - `repeat`  — hear the model, say it back.
 *  - `respond` — answer a question aloud; `target` is the expected answer.
 *  - `read`    — read the written phrase aloud with **no model first**. There
 *                is deliberately no Listen button: hearing it first would make
 *                it a `repeat`. The model unlocks after the first take.
 *  - `recall`  — see the English, produce the target aloud. The target is
 *                hidden; the escape is a reveal that makes the take unscored,
 *                rather than a Listen button that gives the answer away.
 */
export const ACTIVITY_KINDS = ["repeat", "respond", "read", "recall"] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/**
 * How many activities make one lesson — one sitting, with an end.
 *
 * Three is the floor because a sitting of one or two is a drill rather than a
 * lesson, and the end-of-sitting screen would have nothing to summarise. Six
 * is the ceiling because one activity is up to three attempts of up to fifteen
 * seconds plus scoring: past six the sitting outlasts the attention it was
 * sized for, and "about five minutes" on Today stops being true.
 *
 * Mirrored in server/store/content.ts, which is the gate — the same deliberate
 * duplication the content types themselves already follow across that boundary.
 */
export const MIN_LESSON_ACTIVITIES = 3;
export const MAX_LESSON_ACTIVITIES = 6;

export interface Activity {
  id: number;
  title: string;
  kind: ActivityKind;
  /** Shown to the learner as the task. For `respond`, this is the question. */
  prompt: string;
  /** English meaning, so a learner is not guessing at what they are saying. */
  gloss: string;
  /** The text scored against. For `respond`, the expected spoken answer. */
  target: string;
  /** What this activity is designed to expose. Drives the report's advice. */
  focus: string;
  /**
   * The **written syllables** this activity exercises — the mapping the
   * scheduler has been waiting on.
   *
   * `selectActivity` in server/domain/scheduler.ts ranks *sounds* and then
   * picks the phrase that drills the most due, weakest ones at once. Its input
   * is a list of graphemes per activity, and until this field existed there
   * was no such list: the mapping was only learned *after* a learner had
   * attempted an activity, so an unattempted one could be offered as a
   * fallback but never for a reason. That is the whole reason `GET /next`
   * returns due sounds and no activity.
   *
   * Graphemes, not IPA. The skills store keys on the written syllable the
   * provider labelled ("jour", "ment"), case-folded to lower case, so an entry
   * here only ever matches if it is written the same way *and* actually occurs
   * in `target` — both of which the publish gate checks. The phonetic
   * description of what the activity is for belongs in `focus`, which is prose
   * for a human and matches nothing.
   *
   * Optional on the type, and required by the publish gate of any activity a
   * lesson references. Two reasons it cannot simply be mandatory everywhere:
   * the sets that shipped before it existed carry no mapping and are still
   * valid content, and hi-IN comes back from the provider with **no syllable
   * graphemes at all** (measured: 0 of 7 named), so a Hindi list could only
   * ever be data that never matches anything. An activity with no targets is
   * still schedulable — as the documented fallback, never as a recommendation.
   */
  soundTargets?: string[];
}

/**
 * One sitting: a handful of activities with a stated end.
 *
 * `activityIds` rather than nested activities, so the flat `activities` array
 * stays the one place an activity is written down. That is also what keeps a
 * published course readable by a client built before lessons existed — it
 * reads the flat list and ignores the spine — and it means `id` goes on being
 * the single key the React tree, the progress record and the report join on.
 *
 * Lesson ids are unique across the whole language, not per unit: a finished
 * sitting is identified by lesson id alone, exactly as an attempt is
 * identified by activity id alone, and a per-unit numbering would give two
 * lessons one key.
 */
export interface Lesson {
  id: number;
  title: string;
  /**
   * What the learner can do at the end, in their words. Journey pairs it with
   * its receipts, so it is not decoration — and it may only claim what this
   * product measures, which is per-syllable pronunciation and attendance.
   */
  outcome: string;
  /** In order. Between MIN_LESSON_ACTIVITIES and MAX_LESSON_ACTIVITIES of them. */
  activityIds: number[];
}

/**
 * A theme carrying an outcome — the can-do statement a learner is working
 * towards, and the lessons that get them there.
 *
 * Never a locked path. Order is the only thing that reads as sequence, and
 * nothing here can mark a unit unavailable: a hard gate strands exactly the
 * learner whose accent the scorer mishandles.
 */
export interface Unit {
  id: number;
  title: string;
  /** The can-do statement, e.g. "You can order food and be understood." */
  outcome: string;
  lessons: Lesson[];
}

export interface LanguageActivitySet {
  /** Azure pronunciation-assessment locale, e.g. "fr-FR". */
  code: string;
  /** URL segment, e.g. "fr". */
  slug: string;
  /** Shown to the learner, e.g. "French". */
  label: string;
  /**
   * Every activity in the language, flat. Authoritative: the spine below
   * points into this list rather than containing it.
   */
  activities: Activity[];
  /**
   * The course spine — `Language → Unit → Lesson → Activity`.
   *
   * Optional, and that is the compatibility mechanism rather than an
   * oversight. A set with no units is the shape that shipped: a flat ten, with
   * "next" meaning the next array index. A client built before the spine
   * existed ignores this field and still resolves a complete language out of
   * `activities`, and a set published without it is still a working language.
   *
   * When it is present the publish gate requires it to be exhaustive and
   * non-overlapping — every activity in exactly one lesson — because an
   * activity in no lesson is content a learner can never reach, and an
   * activity in two lessons would report one take as progress in both.
   */
  units?: Unit[];
}

export interface ActivityAttempt {
  activityId: number;
  result: PronunciationResult;
  /** Accuracy of this attempt, or null when indeterminate. */
  accuracy: number | null;
  at: string;
}

export interface ActivityProgress {
  activityId: number;
  attempts: ActivityAttempt[];
  /** Best accuracy seen, or null if never scored. */
  best: number | null;
  passed: boolean;
  /** Advanced without passing, after exhausting attempts. */
  skipped: boolean;
}

export interface WeakPhoneme {
  phoneme: string;
  meanAccuracy: number;
  occurrences: number;
}

/**
 * A syllable the learner is consistently getting wrong, keyed by the written
 * form Azure labelled it with ("jour", "ment") rather than a phonetic symbol.
 *
 * Never carries an empty grapheme: an unnamed syllable cannot be grouped with
 * the other takes of the same syllable, so it is counted for
 * `syllableLabelsAvailable` and then dropped rather than pooled into one blank
 * bucket that would read as a finding.
 */
export interface WeakSyllable {
  grapheme: string;
  meanAccuracy: number;
  occurrences: number;
}

export interface WordMistake {
  activityId: number;
  activityTitle: string;
  word: string;
  errorType: string;
  accuracy: number;
}

export interface SessionReport {
  completedCount: number;
  totalCount: number;
  passedCount: number;
  /** Mean of each activity's best accuracy. Null if nothing was scored. */
  overallScore: number | null;
  meanFluency: number | null;
  meanCompleteness: number | null;
  indeterminateCount: number;
  totalAttempts: number;
  /**
   * False when the provider returned phoneme segments with no labels — Azure
   * does this for fr-FR and other non-English locales. The scores are real but
   * unattributable, so per-sound advice cannot be given.
   */
  phonemeLabelsAvailable: boolean;
  /**
   * Empty in practice — every locale Sonare ships returns unlabelled phonemes,
   * so nothing survives the aggregation. Retained because other code reads it
   * and because the exported report JSON is a contract, not because it can
   * still produce advice; the syllable fields below do that.
   */
  weakPhonemes: WeakPhoneme[];
  /**
   * False when syllables came back scored but none came back named, so no
   * syllable can be advised on. Measured per locale, one phrase each: de-DE
   * 8/8 named, es-ES 8/10, fr-FR 4/7, hi-IN 0/7 — Devanagari returns no
   * graphemes at all while still scoring every syllable, and that is the case
   * this flag exists to report honestly instead of showing blanks.
   */
  syllableLabelsAvailable: boolean;
  weakSyllables: WeakSyllable[];
  mistakes: WordMistake[];
  /** Focus areas from activities that were not passed. */
  improvementAreas: string[];
  strongestActivity: { id: number; title: string; score: number } | null;
  weakestActivity: { id: number; title: string; score: number } | null;
  durationMs: number;
}
