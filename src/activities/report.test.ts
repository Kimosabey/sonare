/**
 * The report's per-sound advice, which is keyed on syllables because phonemes
 * are unusable.
 *
 * Azure returns empty `Phoneme` labels for every locale Sonare ships, so the
 * phoneme aggregation can never produce a single row — it is kept for the
 * exported JSON contract, not for advice. `Grapheme` on the syllable is
 * populated instead: 91 of 110 syllables (83%) named across the ten French
 * activity targets, all 110 scored. Per locale, one phrase each: de-DE 8/8
 * named, es-ES 8/10, fr-FR 4/7, hi-IN 0 of 7 — Devanagari scores every
 * syllable and names none.
 *
 * These tests pin the three behaviours that make that data safe to show: an
 * unnamed syllable never becomes a blank chip, "scored but never named" is
 * reported as suppression rather than as "nothing to work on", and a learner
 * who improved on a retry is never advised on the attempt they abandoned.
 *
 * No DOM here on purpose — `report.ts` stays importable by the headless test
 * script, and this suite runs in the default node environment.
 */

import { describe, expect, it } from "vitest";
import { buildReport } from "./report.js";
import type { Activity, ActivityProgress } from "./types.js";
import type { PronunciationResult, ScoredPhoneme, ScoredSyllable, ScoredWord } from "../speech/scoring/types.js";

/**
 * Ticks are irrelevant to aggregation but part of the contract, so they are
 * populated with distinct, plausible values rather than zeros — a bug that
 * grouped on timing instead of grapheme would otherwise pass.
 */
let tickCursor = 400_000;
function syllable(grapheme: string, accuracy: number): ScoredSyllable {
  const offsetTicks = tickCursor;
  tickCursor += 2_500_000;
  return { grapheme, accuracy, offsetTicks, durationTicks: 900_000 };
}

/** Every locale we ship returns phonemes like this: scored, never labelled. */
const unlabeledPhoneme: ScoredPhoneme = { phoneme: "", accuracy: 100 };

function word(text: string, syllables: ScoredSyllable[], accuracy = 70): ScoredWord {
  return { word: text, accuracy, errorType: "None", phonemes: [unlabeledPhoneme], syllables };
}

function scoredResult(words: ScoredWord[], accuracy: number): PronunciationResult {
  return {
    indeterminate: false,
    provider: "azure",
    recognized: words.map((w) => w.word).join(" "),
    overall: accuracy,
    accuracy,
    fluency: 80,
    completeness: 100,
    words,
  };
}

/** One activity's progress from a list of attempts, best-first-agnostic. */
function progressOf(
  activityId: number,
  attempts: { accuracy: number; words: ScoredWord[] }[],
): ActivityProgress {
  const best = attempts.length === 0 ? null : Math.max(...attempts.map((a) => a.accuracy));
  return {
    activityId,
    attempts: attempts.map((a) => ({
      activityId,
      result: scoredResult(a.words, a.accuracy),
      accuracy: a.accuracy,
      at: new Date(0).toISOString(),
    })),
    best,
    passed: (best ?? 0) >= 80,
    skipped: false,
  };
}

const ACTIVITY: Activity = {
  id: 1,
  title: "Greeting",
  kind: "repeat",
  prompt: "Bonjour, comment allez-vous ?",
  gloss: "Hello, how are you?",
  target: "Bonjour, comment allez-vous",
  focus: "nasal vowels",
};

const activities = [ACTIVITY];

function reportFor(progress: ActivityProgress[]) {
  return buildReport(activities, progress, 60_000);
}

describe("buildReport syllable advice", () => {
  it("averages every occurrence of a named syllable and ranks the worst first", () => {
    const report = reportFor([
      progressOf(1, [
        {
          accuracy: 60,
          words: [
            word("Bonjour", [syllable("bon", 74), syllable("jour", 50)]),
            word("comment", [syllable("com", 66), syllable("ment", 60)]),
          ],
        },
      ]),
    ]);

    expect(report.syllableLabelsAvailable).toBe(true);
    expect(report.weakSyllables).toEqual([]);

    // One take of each syllable is one data point, and MIN_OCCURRENCES is 2 —
    // a single bad syllable is a slip, not a pattern. Say it twice and it is.
    const repeated = reportFor([
      progressOf(1, [
        {
          accuracy: 60,
          words: [
            word("Bonjour", [syllable("bon", 74), syllable("jour", 50)]),
            word("Bonjour", [syllable("bon", 66), syllable("jour", 60)]),
          ],
        },
      ]),
    ]);

    expect(repeated.weakSyllables).toEqual([
      { grapheme: "jour", meanAccuracy: 55, occurrences: 2 },
      { grapheme: "bon", meanAccuracy: 70, occurrences: 2 },
    ]);
  });

  it("leaves a syllable at the 80 pass band out of the advice", () => {
    const report = reportFor([
      progressOf(1, [
        {
          accuracy: 80,
          words: [word("Bonjour", [syllable("bon", 80), syllable("bon", 80)])],
        },
      ]),
    ]);

    // T12's pass band is inclusive, so exactly 80 is not a problem to work on.
    expect(report.weakSyllables).toEqual([]);
    expect(report.syllableLabelsAvailable).toBe(true);
  });

  it("shows at most six syllables, keeping the six worst", () => {
    const graphemes = ["a", "b", "c", "d", "e", "f", "g"];
    const syllables = graphemes.flatMap((g, i) => [syllable(g, 10 + i * 5), syllable(g, 10 + i * 5)]);
    const report = reportFor([progressOf(1, [{ accuracy: 30, words: [word("long", syllables)] }])]);

    expect(report.weakSyllables).toHaveLength(6);
    expect(report.weakSyllables.map((s) => s.grapheme)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("does not group two takes of one syllable by their capitalisation", () => {
    const report = reportFor([
      progressOf(1, [
        {
          accuracy: 40,
          words: [word("Bonjour", [syllable("Bon", 40)]), word("bonbon", [syllable("bon", 50)])],
        },
      ]),
    ]);

    // Two buckets of one would each fall under MIN_OCCURRENCES and vanish, so
    // the failure mode of getting this wrong is silence, not a wrong number.
    expect(report.weakSyllables).toEqual([{ grapheme: "bon", meanAccuracy: 45, occurrences: 2 }]);
  });
});

describe("buildReport unnamed syllables", () => {
  it("never turns unnamed syllables into a blank bucket", () => {
    // The fr-FR shape: 4 of 7 named, the misses on elision and hyphenation.
    const report = reportFor([
      progressOf(1, [
        {
          accuracy: 55,
          words: [
            word("comment", [syllable("com", 40), syllable("ment", 45)]),
            word("comment", [syllable("com", 50), syllable("ment", 55)]),
            word("allez-vous", [syllable("", 20), syllable("", 22), syllable("", 24)]),
          ],
        },
      ]),
    ]);

    expect(report.weakSyllables.map((s) => s.grapheme)).toEqual(["com", "ment"]);
    expect(report.weakSyllables.every((s) => s.grapheme !== "")).toBe(true);
    // The unnamed three scored worst of all; if they had been pooled they would
    // have led the list with an empty label.
    expect(report.syllableLabelsAvailable).toBe(true);
  });

  it("suppresses the advice when syllables are scored but none are named — hi-IN", () => {
    const report = reportFor([
      progressOf(1, [
        {
          accuracy: 45,
          words: [
            word("नमस्ते", [syllable("", 30), syllable("", 35), syllable("", 40)]),
            word("आप", [syllable("", 45), syllable("", 50)]),
            word("कैसे", [syllable("", 55), syllable("", 60)]),
          ],
        },
      ]),
    ]);

    // 0 of 7 named. "We cannot name these" is honest; an empty list would read
    // as "nothing to work on" for a take that scored 45.
    expect(report.syllableLabelsAvailable).toBe(false);
    expect(report.weakSyllables).toEqual([]);
  });

  it("treats a word with no syllables at all as nothing being withheld", () => {
    const report = reportFor([progressOf(1, [{ accuracy: 90, words: [word("Bonjour", [])] }])]);

    // Nothing to suppress is not the same as suppression: the UI must not
    // explain away data that was never returned in the first place.
    expect(report.syllableLabelsAvailable).toBe(true);
    expect(report.weakSyllables).toEqual([]);
  });
});

describe("buildReport attempt selection", () => {
  it("advises on the best attempt only, not the retries that got there", () => {
    const report = reportFor([
      progressOf(1, [
        { accuracy: 30, words: [word("Bonjour", [syllable("jour", 25), syllable("jour", 30)])] },
        { accuracy: 92, words: [word("Bonjour", [syllable("jour", 90), syllable("jour", 94)])] },
      ]),
    ]);

    // Telling a learner who fixed a syllable that it is still their weakest is
    // both wrong and discouraging.
    expect(report.weakSyllables).toEqual([]);
    expect(report.totalAttempts).toBe(2);
  });

  it("ignores an indeterminate attempt when picking the attempt to advise on", () => {
    const progress = progressOf(1, [
      { accuracy: 40, words: [word("Bonjour", [syllable("jour", 40), syllable("jour", 44)])] },
    ]);
    const indeterminate: PronunciationResult = {
      indeterminate: true,
      provider: "azure",
      reason: "no speech found to assess — every word was omitted",
    };
    progress.attempts.push({ activityId: 1, result: indeterminate, accuracy: null, at: new Date(0).toISOString() });

    const report = reportFor([progress]);

    // R8: an indeterminate attempt is not a zero, so it must neither win the
    // "best" comparison nor contribute syllables of its own.
    expect(report.indeterminateCount).toBe(1);
    expect(report.weakSyllables).toEqual([{ grapheme: "jour", meanAccuracy: 42, occurrences: 2 }]);
  });

  it("gives no syllable advice when nothing was scored", () => {
    const report = reportFor([progressOf(1, [])]);

    expect(report.weakSyllables).toEqual([]);
    expect(report.syllableLabelsAvailable).toBe(true);
    expect(report.overallScore).toBeNull();
  });
});

describe("buildReport phoneme advice alongside", () => {
  it("keeps reporting phonemes as unlabelled while syllable advice works", () => {
    const report = reportFor([
      progressOf(1, [
        {
          accuracy: 50,
          words: [word("comment", [syllable("ment", 40), syllable("ment", 50)])],
        },
      ]),
    ]);

    // The two flags are independent, and this is the combination every shipped
    // locale actually produces: phonemes scored but nameless, syllables named.
    expect(report.phonemeLabelsAvailable).toBe(false);
    expect(report.weakPhonemes).toEqual([]);
    expect(report.syllableLabelsAvailable).toBe(true);
    expect(report.weakSyllables).toEqual([{ grapheme: "ment", meanAccuracy: 45, occurrences: 2 }]);
  });
});

/**
 * Progress survives across sessions via localStorage, so buildReport() is
 * routinely handed results it did not just receive from the server. A stored
 * result predating a field is therefore normal input, not a corrupt one — and
 * a required field in the type says nothing about JSON written before that
 * type existed.
 *
 * This is a regression test for a real crash: reopening a saved session threw
 * "word.syllables is not iterable" and the whole activity screen went to the
 * error boundary.
 */
describe("buildReport tolerates results that predate a field", () => {
  it("does not throw when a restored word has no syllables array at all", () => {
    const legacyWord = {
      word: "Bonjour",
      accuracy: 90,
      errorType: "None",
      phonemes: [],
      // `syllables` deliberately absent — exactly what a v1 localStorage entry holds.
    } as unknown as ScoredWord;

    const activities: Activity[] = [
      {
        id: 1,
        title: "Greetings",
        kind: "repeat",
        prompt: "Say hello",
        gloss: "Hello",
        target: "Bonjour",
        focus: "nasal vowels",
      },
    ];

    const progress: ActivityProgress[] = [
      {
        activityId: 1,
        best: 90,
        passed: true,
        skipped: false,
        attempts: [
          {
            activityId: 1,
            accuracy: 90,
            at: new Date().toISOString(),
            result: {
              indeterminate: false,
              provider: "azure",
              recognized: "Bonjour",
              overall: 90,
              accuracy: 90,
              fluency: 90,
              completeness: 100,
              words: [legacyWord],
            },
          },
        ],
      },
    ];

    expect(() => buildReport(activities, progress, 1000)).not.toThrow();
    const report = buildReport(activities, progress, 1000);
    expect(report.weakSyllables).toEqual([]);
    expect(report.overallScore).toBe(90);
  });

  it("does not throw when a restored word has no phonemes array either", () => {
    const legacyWord = { word: "Bonjour", accuracy: 90, errorType: "None" } as unknown as ScoredWord;

    const activities: Activity[] = [
      { id: 1, title: "Greetings", kind: "repeat", prompt: "p", gloss: "g", target: "Bonjour", focus: "f" },
    ];
    const progress: ActivityProgress[] = [
      {
        activityId: 1,
        best: 90,
        passed: true,
        skipped: false,
        attempts: [
          {
            activityId: 1,
            accuracy: 90,
            at: new Date().toISOString(),
            result: {
              indeterminate: false,
              provider: "azure",
              recognized: "Bonjour",
              overall: 90,
              accuracy: 90,
              fluency: 90,
              completeness: 100,
              words: [legacyWord],
            },
          },
        ],
      },
    ];

    expect(() => buildReport(activities, progress, 1000)).not.toThrow();
  });
});
