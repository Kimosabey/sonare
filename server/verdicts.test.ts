/**
 * Two verdicts about the same take, and whether the disagreement is findable.
 *
 * Storing both opinions is only worth doing if someone can pull the
 * interesting attempts out of a trail of hundreds. So the test that matters
 * most is not that the counts are right — it is that `disagrees` and
 * `providerCannotExpress` actually separate the cases worth reading from the
 * ones that agree, and that an indeterminate take does not masquerade as a
 * disagreement.
 */

import { describe, expect, it } from "vitest";
import { alignSpoken } from "./alignment.js";
import { compareVerdicts } from "./verdicts.js";
import type { PronunciationResult, ScoredWord } from "./services/types.js";

function word(text: string, errorType: ScoredWord["errorType"], accuracy = 80): ScoredWord {
  return { word: text, accuracy, errorType, phonemes: [], syllables: [] };
}

function scored(recognized: string, words: ScoredWord[]): PronunciationResult {
  return {
    indeterminate: false,
    provider: "azure",
    recognized,
    overall: 80,
    accuracy: 80,
    fluency: 85,
    completeness: 90,
    words,
  };
}

const unclear: PronunciationResult = {
  indeterminate: true,
  provider: "azure",
  reason: "no speech found to assess — every word was omitted",
};

/** The pair as the route computes it. */
function compare(expected: string, result: PronunciationResult) {
  const heard = result.indeterminate ? "" : result.recognized;
  return compareVerdicts(result, alignSpoken(expected, heard));
}

describe("when the two verdicts agree", () => {
  it("says so for a clean take", () => {
    const expected = "Bonjour comment allez-vous";
    const result = scored("bonjour comment allez vous", [
      word("bonjour", "None"),
      word("comment", "None"),
      word("allez", "None"),
      word("vous", "None"),
    ]);

    const verdict = compare(expected, result);

    expect(verdict.disagrees).toBe(false);
    expect(verdict.omissionDelta).toBe(0);
    expect(verdict.providerCannotExpress).toBe(0);
  });

  it("says so for a dropped word both of them found", () => {
    /**
     * The example this work started from. Azure marks `allez` as an omission
     * and the alignment finds it missing — they agree, which is worth
     * recording as plainly as a disagreement. It is also the evidence that
     * the alignment was not built because omission detection was broken.
     */
    const expected = "Bonjour comment allez-vous";
    const result = scored("bonjour comment vous", [
      word("bonjour", "None"),
      word("comment", "None"),
      word("allez", "Omission", 0),
      word("vous", "None"),
    ]);

    const verdict = compare(expected, result);

    expect(verdict.providerOmissions).toBe(1);
    expect(verdict.alignedMissing).toBe(1);
    expect(verdict.disagrees).toBe(false);
  });
});

describe("when they disagree", () => {
  it("flags a provider omission the transcript contradicts", () => {
    /**
     * The interesting direction. Azure's miscue verdict says the word was
     * omitted while its own transcript contains it — the two halves of one
     * response telling different stories about the same audio. Exactly the
     * kind of attempt a fixture analysis should read by hand, and impossible
     * to find without this flag.
     */
    const expected = "Je voudrais un café";
    const result = scored("je voudrais un café", [
      word("je", "None"),
      word("voudrais", "None"),
      word("un", "None"),
      word("café", "Omission", 0),
    ]);

    const verdict = compare(expected, result);

    expect(verdict.providerOmissions).toBe(1);
    expect(verdict.alignedMissing).toBe(0);
    expect(verdict.omissionDelta).toBe(1);
    expect(verdict.disagrees).toBe(true);
  });

  it("flags the other direction too", () => {
    // The alignment finds a word absent that Azure scored as present.
    const expected = "Je voudrais un café";
    const result = scored("je voudrais café", [
      word("je", "None"),
      word("voudrais", "None"),
      word("café", "None"),
    ]);

    const verdict = compare(expected, result);

    expect(verdict.alignedMissing).toBe(1);
    expect(verdict.providerOmissions).toBe(0);
    expect(verdict.omissionDelta).toBe(-1);
    expect(verdict.disagrees).toBe(true);
  });

  it("keeps the sign, so the direction survives into the trail", () => {
    // Which way round it runs is the whole information. An absolute value
    // would collapse "Azure over-reports" and "we over-report" into one
    // number that answers neither question.
    const overReported = compare(
      "un deux trois",
      scored("un deux trois", [word("un", "Omission", 0), word("deux", "None"), word("trois", "None")]),
    );
    const underReported = compare("un deux trois", scored("un trois", [word("un", "None"), word("trois", "None")]));

    expect(overReported.omissionDelta).toBeGreaterThan(0);
    expect(underReported.omissionDelta).toBeLessThan(0);
  });
});

describe("what only the alignment can say", () => {
  it("counts a substitution as something the provider has no type for", () => {
    /**
     * Azure has no Substitution error type, so a swapped word arrives as an
     * omission and an insertion with nothing pairing them. This figure is the
     * alignment earning its place: non-zero means it found something the
     * provider structurally cannot report.
     */
    const expected = "Je voudrais un croissant";
    const result = scored("je voudrais un café", [
      word("je", "None"),
      word("voudrais", "None"),
      word("un", "None"),
      word("croissant", "Omission", 0),
      word("café", "Insertion", 40),
    ]);

    const verdict = compare(expected, result);

    expect(verdict.alignedSubstituted).toBe(1);
    expect(verdict.providerCannotExpress).toBe(1);
    // Azure reported two faults for the one thing that happened.
    expect(verdict.providerOmissions + verdict.providerInsertions).toBe(2);
  });

  it("counts a repetition the same way", () => {
    const expected = "Bonjour comment allez-vous";
    const result = scored("bonjour bonjour comment allez vous", [
      word("bonjour", "None"),
      word("bonjour", "Insertion", 60),
      word("comment", "None"),
      word("allez", "None"),
      word("vous", "None"),
    ]);

    const verdict = compare(expected, result);

    expect(verdict.alignedRepeated).toBe(1);
    expect(verdict.providerCannotExpress).toBe(1);
  });

  it("stays at zero when the alignment found nothing extra to say", () => {
    // So a non-zero value always means something, rather than tracking the
    // number of takes.
    const verdict = compare("un deux", scored("un deux", [word("un", "None"), word("deux", "None")]));

    expect(verdict.providerCannotExpress).toBe(0);
  });
});

describe("an indeterminate take is not a disagreement", () => {
  it("reports no disagreement when there was nothing to compare", () => {
    /**
     * There is no transcript, so the alignment reports every word missing —
     * true, and not a conflict with anything. Counting it as one would make
     * this figure track the 9.4% indeterminate rate instead of the thing it
     * exists to measure, and the trail would fill with attempts nobody needs
     * to read.
     */
    const verdict = compare("Bonjour comment allez-vous", unclear);

    expect(verdict.disagrees).toBe(false);
    expect(verdict.omissionDelta).toBe(0);
    expect(verdict.providerOmissions).toBe(0);
    expect(verdict.providerWords).toBe(0);
  });

  it("still records how many words were asked for", () => {
    // The reference is known even when nothing was heard, and an analysis
    // grouping by phrase length needs it.
    const verdict = compare("Bonjour comment allez-vous", unclear);

    expect(verdict.expectedWords).toBe(4);
  });
});

describe("shape", () => {
  it("carries no score of any kind", () => {
    /**
     * R3's reasoning applies to a number derived from two verdicts just as
     * much as to one derived from confidence: this is evidence for a fixture
     * run, not a measurement of the learner. Nothing here may become the
     * figure a pass is decided on.
     */
    const verdict = compare("un deux", scored("un deux", [word("un", "None"), word("deux", "None")]));
    const keys = Object.keys(verdict).join(" ").toLowerCase();

    expect(keys).not.toContain("score");
    expect(keys).not.toContain("accuracy");
    expect(keys).not.toContain("confidence");
    expect(keys).not.toContain("pass");
  });

  it("counts provider words separately from reference words", () => {
    // They differ whenever Azure heard something other than the phrase, and
    // conflating them would hide exactly that.
    const expected = "un deux trois";
    const result = scored("un deux trois quatre", [
      word("un", "None"),
      word("deux", "None"),
      word("trois", "None"),
      word("quatre", "Insertion", 30),
    ]);

    const verdict = compare(expected, result);

    expect(verdict.expectedWords).toBe(3);
    expect(verdict.providerWords).toBe(4);
  });
});
