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

export type ActivityKind = "repeat" | "respond" | "read";

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
}

export interface LanguageActivitySet {
  /** Azure pronunciation-assessment locale, e.g. "fr-FR". */
  code: string;
  /** URL segment, e.g. "fr". */
  slug: string;
  /** Shown to the learner, e.g. "French". */
  label: string;
  activities: Activity[];
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
