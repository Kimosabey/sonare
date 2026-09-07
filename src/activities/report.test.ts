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
import { buildReport, verdictFor } from "./report.js";
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

  it("does not report NaN when a restored result has no fluency or completeness", () => {
    /**
     * The same class one level up, and this loop guarded the word and not the
     * result. `undefined` sums to NaN, and `mean()` then divides that NaN
     * across the whole session — so one stale attempt out of ten renders "NaN"
     * where the learner's fluency and completeness should be, on every
     * activity in the report.
     *
     * The remaining attempts still count. Skipping a contribution costs one
     * attempt's data; including it costs the number.
     */
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
      {
        id: 2,
        title: "Introductions",
        kind: "repeat",
        prompt: "Introduce yourself",
        gloss: "My name is",
        target: "Je m'appelle Marie",
        focus: "elision",
      },
    ];

    const attempt = (activityId: number, result: unknown): ActivityProgress =>
      ({
        activityId,
        best: 90,
        passed: true,
        skipped: false,
        attempts: [{ activityId, accuracy: 90, at: new Date().toISOString(), result }],
      }) as unknown as ActivityProgress;

    const complete = {
      indeterminate: false,
      provider: "azure",
      recognized: "Bonjour",
      overall: 90,
      accuracy: 90,
      fluency: 80,
      completeness: 100,
      words: [],
    };
    // A v1-shaped entry: scored, but written before these two fields existed.
    const stale = { indeterminate: false, provider: "azure", recognized: "x", overall: 90, accuracy: 90, words: [] };

    const report = buildReport(activities, [attempt(1, complete), attempt(2, stale)], 1000);

    expect(Number.isNaN(report.meanFluency)).toBe(false);
    expect(Number.isNaN(report.meanCompleteness)).toBe(false);
    // The good attempt still counts, at its own value rather than halved.
    expect(report.meanFluency).toBe(80);
    expect(report.meanCompleteness).toBe(100);
  });

  it("reports no mean at all when every restored result lacks the field", () => {
    // Null, not zero. Nothing was measured, so there is no average — the same
    // distinction R8 draws about scores.
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
    const progress = [
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
            result: { indeterminate: false, provider: "azure", recognized: "x", overall: 90, accuracy: 90, words: [] },
          },
        ],
      },
    ] as unknown as ActivityProgress[];

    const report = buildReport(activities, progress, 1000);

    expect(report.meanFluency).toBeNull();
    expect(report.meanCompleteness).toBeNull();
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

/**
 * Four claims a mutation sweep found unpinned. Each one is silent when wrong —
 * the report still renders, still looks like a report, and misstates what the
 * learner did.
 */
describe("what the report claims", () => {
  it("lists only actual mistakes, not every word", () => {
    /**
     * The `errorType && errorType !== "None"` guard. Azure sends "None" for a
     * word the learner got right, so flattening that condition puts every
     * correct word in the mistakes table — and the table is sorted worst-first
     * and presented as what to work on. A learner who scored 95 would be shown
     * a list of everything they said.
     */
    const report = reportFor([
      progressOf(1, [
        {
          accuracy: 90,
          words: [
            { word: "bonjour", accuracy: 95, errorType: "None", phonemes: [], syllables: [] },
            { word: "comment", accuracy: 92, errorType: "None", phonemes: [], syllables: [] },
            { word: "allez", accuracy: 41, errorType: "Mispronunciation", phonemes: [], syllables: [] },
          ],
        },
      ]),
    ]);

    expect(report.mistakes).toHaveLength(1);
    expect(report.mistakes[0]?.word).toBe("allez");
  });

  it("treats a missing errorType as no mistake rather than as one", () => {
    // Restored progress again: a word written before the field existed has no
    // errorType, and an absent value is not evidence of an error.
    const stale = { word: "bonjour", accuracy: 95, phonemes: [], syllables: [] } as unknown as ScoredWord;

    const report = reportFor([progressOf(1, [{ accuracy: 95, words: [stale] }])]);

    expect(report.mistakes).toEqual([]);
  });

  it("needs a sound to recur before calling it a weakness", () => {
    /**
     * MIN_OCCURRENCES is 2 so that one bad take does not become a finding —
     * a learner who fluffed "ment" once has not got a problem with "ment".
     * Both halves of the filter matter: dropping the count check promotes
     * noise, and dropping the ceiling check reports strong sounds as weak.
     */
    const once = reportFor([
      progressOf(1, [{ accuracy: 70, words: [word("comment", [syllable("ment", 40)])] }]),
    ]);

    expect(once.weakSyllables).toEqual([]);
  });

  it("calls it a weakness once it recurs", () => {
    const twice = reportFor([
      progressOf(1, [
        { accuracy: 70, words: [word("comment", [syllable("ment", 40), syllable("ment", 44)])] },
      ]),
    ]);

    expect(twice.weakSyllables.map((s) => s.grapheme)).toEqual(["ment"]);
  });

  it("does not report a strong sound as weak however often it recurs", () => {
    // The ceiling half. A syllable at 95 heard ten times is the learner's
    // best sound, and listing it under "work on these" is worse than listing
    // nothing.
    const report = reportFor([
      progressOf(1, [
        {
          accuracy: 95,
          words: [word("bonjour", [syllable("bon", 95), syllable("bon", 96), syllable("bon", 94)])],
        },
      ]),
    ]);

    expect(report.weakSyllables).toEqual([]);
  });

  it("does not name one activity as both the strongest and the weakest", () => {
    /**
     * `ranked.length > 1`. With one scored activity, top and bottom are the
     * same row — and a report that calls a single activity both the learner's
     * best and their worst is nonsense they will notice immediately.
     */
    const report = reportFor([progressOf(1, [{ accuracy: 88, words: [] }])]);

    expect(report.strongestActivity?.id).toBe(1);
    expect(report.weakestActivity).toBeNull();
  });

  it("survives progress that references an activity no longer in the set", () => {
    /**
     * The stale-data class once more. Progress is restored from storage while
     * the activity list ships with the code, so a content change can leave a
     * saved session pointing at an id that no longer exists. Every lookup here
     * is optional-chained for that reason, and unchaining any of them throws
     * while building the report — taking the whole end-of-session screen with
     * it, at the one moment the learner has nothing left to retry.
     */
    const orphan = progressOf(99, [
      { accuracy: 62, words: [{ word: "x", accuracy: 41, errorType: "Mispronunciation", phonemes: [], syllables: [] }] },
    ]);

    expect(() => reportFor([orphan])).not.toThrow();
    const report = reportFor([orphan]);
    // Named by id rather than left blank, so the row is still identifiable.
    expect(report.mistakes[0]?.activityTitle).toBe("Activity 99");
    expect(report.strongestActivity?.title).toBe("");
  });
});

/**
 * The three claims the previous pass left unpinned, each for a different
 * reason worth recording.
 */
describe("the phoneme weakness filter", () => {
  /**
   * Phonemes come back *unlabelled* for all four shipped locales, so this
   * filter is dead on the learner path — which is exactly why it went
   * untested. It is not dead everywhere: en-US returns fully labelled
   * phonemes (21 of 21 measured) and the fixture runner can select en-US, so
   * an en-US fixture session is scored through this code.
   */
  function withPhonemes(phonemes: { phoneme: string; accuracy: number }[]) {
    return reportFor([
      progressOf(1, [
        {
          accuracy: 70,
          words: [{ word: "drink", accuracy: 70, errorType: "None", phonemes, syllables: [] }],
        },
      ]),
    ]);
  }

  it("needs a phoneme to recur before calling it a weakness", () => {
    // One bad instance is not a pattern, and MIN_OCCURRENCES is what stops
    // the report presenting it as one.
    expect(withPhonemes([{ phoneme: "ɹ", accuracy: 40 }]).weakPhonemes).toEqual([]);
  });

  it("names it once it recurs", () => {
    const report = withPhonemes([
      { phoneme: "ɹ", accuracy: 40 },
      { phoneme: "ɹ", accuracy: 44 },
    ]);

    expect(report.weakPhonemes.map((p) => p.phoneme)).toEqual(["ɹ"]);
    expect(report.weakPhonemes[0]?.occurrences).toBe(2);
  });

  it("does not report a strong phoneme as weak however often it recurs", () => {
    const report = withPhonemes([
      { phoneme: "d", accuracy: 95 },
      { phoneme: "d", accuracy: 97 },
      { phoneme: "d", accuracy: 93 },
    ]);

    expect(report.weakPhonemes).toEqual([]);
  });
});

describe("verdictFor", () => {
  it("says nothing was scored when nothing was", () => {
    /**
     * The null guard, and the reason it is a guard rather than a formatting
     * detail: without it `Math.round(null)` is 0, which falls through to
     * "Needs work. Focus on the sounds listed below" — telling a learner whose
     * every take was unscoreable that their pronunciation needs work, and
     * pointing them at a list of sounds that is empty. R8 with a sentence
     * around it.
     */
    const report = reportFor([]);

    expect(report.overallScore).toBeNull();
    expect(verdictFor(report)).toBe("No activities were scored.");
  });

  it("grades a scored session on its own score", () => {
    // The other side: a real score must not be reported as unscored.
    expect(verdictFor(reportFor([progressOf(1, [{ accuracy: 92, words: [] }])]))).toMatch(/^Strong/);
    expect(verdictFor(reportFor([progressOf(1, [{ accuracy: 75, words: [] }])]))).toMatch(/^Solid/);
    expect(verdictFor(reportFor([progressOf(1, [{ accuracy: 60, words: [] }])]))).toMatch(/^Developing/);
    expect(verdictFor(reportFor([progressOf(1, [{ accuracy: 30, words: [] }])]))).toMatch(/^Needs work/);
  });

  it("puts each band boundary on the generous side", () => {
    /**
     * A learner who scores exactly 85 is told "Strong", not "Solid". Every one
     * of these is a sentence about the person reading it, so the boundary
     * belongs on the side that credits the score they achieved rather than the
     * one below it — and each is a separate `>=` that could drift alone.
     */
    const verdict = (accuracy: number) =>
      verdictFor(reportFor([progressOf(1, [{ accuracy, words: [] }])]));

    expect(verdict(85)).toMatch(/^Strong/);
    expect(verdict(84)).toMatch(/^Solid/);
    expect(verdict(70)).toMatch(/^Solid/);
    expect(verdict(69)).toMatch(/^Developing/);
    expect(verdict(55)).toMatch(/^Developing/);
    expect(verdict(54)).toMatch(/^Needs work/);
  });
});

describe("an attempt that scored exactly zero", () => {
  it("is treated as a score, not as the absence of one", () => {
    /**
     * `attempt.accuracy ?? -1`, and the distinction `??` draws that `||` does
     * not: a genuine 0 is falsy, so `0 || -1` is -1 and the attempt would sort
     * as worse than "no score at all". It has to count as the score it is —
     * R8 draws the same line, and this is the arithmetic end of it.
     *
     * Rare but reachable: a partially recognised utterance can score 0 without
     * tripping the all-omitted guard that turns a take indeterminate.
     */
    const report = reportFor([
      progressOf(1, [
        { accuracy: 0, words: [] },
        { accuracy: 62, words: [] },
      ]),
    ]);

    // The better attempt still wins, and the zero did not become a sentinel.
    expect(report.overallScore).toBe(62);
    expect(report.indeterminateCount).toBe(0);
    expect(report.totalAttempts).toBe(2);
  });
});

describe("a weakest activity that no longer exists", () => {
  it("survives, where the previous orphan test could not reach", () => {
    /**
     * `weakestActivity` is only computed when more than one activity scored,
     * so a single-activity orphan test never evaluates its title lookup —
     * which is how that optional chain stayed unpinned. Two orphans reach it.
     */
    const progress = [
      progressOf(98, [{ accuracy: 88, words: [] }]),
      progressOf(99, [{ accuracy: 41, words: [] }]),
    ];

    expect(() => reportFor(progress)).not.toThrow();
    const report = reportFor(progress);

    expect(report.strongestActivity?.id).toBe(98);
    expect(report.weakestActivity?.id).toBe(99);
    expect(report.weakestActivity?.title).toBe("");
  });
});
