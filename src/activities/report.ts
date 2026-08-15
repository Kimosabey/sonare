/**
 * Report computation. Deliberately pure and free of React and DOM so the
 * end-to-end test script can import it and assert on the same numbers the UI
 * renders — a report that is only computed inside a component can only be
 * tested by driving a browser.
 */

import type { Activity, ActivityProgress, SessionReport, WeakPhoneme, WordMistake } from "./types.js";

/** A phoneme needs this many occurrences before it is worth advising on. */
const MIN_OCCURRENCES = 2;

/** Below this mean accuracy a phoneme is worth calling out. */
const WEAK_PHONEME_CEILING = 80;

const MAX_WEAK_PHONEMES = 6;

export function buildReport(
  activities: Activity[],
  progress: ActivityProgress[],
  durationMs: number,
): SessionReport {
  const byId = new Map(activities.map((a) => [a.id, a]));

  const phonemeTotals = new Map<string, { sum: number; count: number }>();
  const mistakes: WordMistake[] = [];
  const fluencies: number[] = [];
  const completenesses: number[] = [];

  let indeterminateCount = 0;
  let totalAttempts = 0;
  let unlabeledPhonemes = 0;

  for (const p of progress) {
    const activity = byId.get(p.activityId);
    totalAttempts += p.attempts.length;

    // Only the best attempt informs the advice. Counting every failed retry
    // would tell a learner who improved that they are worse than they are.
    let bestAttempt: (typeof p.attempts)[number] | null = null;
    for (const attempt of p.attempts) {
      if (attempt.result.indeterminate) {
        indeterminateCount++;
        continue;
      }
      if (!bestAttempt || (attempt.accuracy ?? -1) > (bestAttempt.accuracy ?? -1)) {
        bestAttempt = attempt;
      }
    }

    if (!bestAttempt || bestAttempt.result.indeterminate) continue;

    const result = bestAttempt.result;
    fluencies.push(result.fluency);
    completenesses.push(result.completeness);

    for (const word of result.words) {
      if (word.errorType && word.errorType !== "None") {
        mistakes.push({
          activityId: p.activityId,
          activityTitle: activity?.title ?? `Activity ${p.activityId}`,
          word: word.word,
          errorType: word.errorType,
          accuracy: word.accuracy,
        });
      }
      for (const phoneme of word.phonemes) {
        // Azure returns unlabeled phoneme segments for fr-FR and other
        // non-English locales: real scores, empty `Phoneme`. Aggregating those
        // would collapse every sound in the language into one "" bucket and
        // present it as a finding, which is worse than reporting nothing.
        if (!phoneme.phoneme) {
          unlabeledPhonemes++;
          continue;
        }
        const entry = phonemeTotals.get(phoneme.phoneme) ?? { sum: 0, count: 0 };
        entry.sum += phoneme.accuracy;
        entry.count += 1;
        phonemeTotals.set(phoneme.phoneme, entry);
      }
    }
  }

  const weakPhonemes: WeakPhoneme[] = [...phonemeTotals.entries()]
    .map(([phoneme, { sum, count }]) => ({
      phoneme,
      meanAccuracy: sum / count,
      occurrences: count,
    }))
    .filter((p) => p.occurrences >= MIN_OCCURRENCES && p.meanAccuracy < WEAK_PHONEME_CEILING)
    .sort((a, b) => a.meanAccuracy - b.meanAccuracy)
    .slice(0, MAX_WEAK_PHONEMES);

  const scored = progress.filter((p) => p.best !== null);
  const overallScore =
    scored.length > 0 ? scored.reduce((sum, p) => sum + (p.best ?? 0), 0) / scored.length : null;

  const ranked = [...scored].sort((a, b) => (b.best ?? 0) - (a.best ?? 0));
  const top = ranked[0];
  const bottom = ranked[ranked.length - 1];

  const improvementAreas = progress
    .filter((p) => !p.passed)
    .map((p) => byId.get(p.activityId)?.focus)
    .filter((f): f is string => Boolean(f));

  return {
    completedCount: progress.length,
    totalCount: activities.length,
    passedCount: progress.filter((p) => p.passed).length,
    overallScore,
    meanFluency: mean(fluencies),
    meanCompleteness: mean(completenesses),
    indeterminateCount,
    totalAttempts,
    phonemeLabelsAvailable: phonemeTotals.size > 0 || unlabeledPhonemes === 0,
    weakPhonemes,
    // Worst first — the learner should see the biggest problem at the top.
    mistakes: mistakes.sort((a, b) => a.accuracy - b.accuracy),
    improvementAreas,
    strongestActivity:
      top && top.best !== null
        ? { id: top.activityId, title: byId.get(top.activityId)?.title ?? "", score: top.best }
        : null,
    weakestActivity:
      bottom && bottom.best !== null && ranked.length > 1
        ? { id: bottom.activityId, title: byId.get(bottom.activityId)?.title ?? "", score: bottom.best }
        : null,
    durationMs,
  };
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** One-line verdict for the top of the report. */
export function verdictFor(report: SessionReport): string {
  if (report.overallScore === null) return "No activities were scored.";
  const score = Math.round(report.overallScore);
  if (score >= 85) return "Strong. Pronunciation is clear and consistent across the set.";
  if (score >= 70) return "Solid. A few sounds need attention, but you are understandable throughout.";
  if (score >= 55) return "Developing. The basics are there; specific sounds are holding you back.";
  return "Needs work. Focus on the sounds listed below before moving on.";
}
