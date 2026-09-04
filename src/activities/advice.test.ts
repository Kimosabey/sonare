/**
 * Advice has to be worth acting on or it is noise sitting where a learner
 * expects help. So the cases that matter are the ones where it should say
 * *nothing* — a clean take, an unmeasured one — as much as the ones where it
 * should name a syllable.
 */

import { describe, expect, it } from "vitest";
import { adviceFor, weakestSyllable } from "./advice.js";
import type { PronunciationResult, ScoredSyllable, ScoredWord } from "../speech/scoring/types.js";

function syllable(grapheme: string, accuracy: number, offsetTicks = 0): ScoredSyllable {
  return { grapheme, accuracy, offsetTicks, durationTicks: 2_000_000 };
}

function word(text: string, syllables: ScoredSyllable[]): ScoredWord {
  return { word: text, accuracy: 80, errorType: "None", phonemes: [], syllables };
}

function scored(words: ScoredWord[]): PronunciationResult {
  return {
    indeterminate: false,
    provider: "azure",
    recognized: words.map((w) => w.word).join(" "),
    overall: 80,
    accuracy: 80,
    fluency: 80,
    completeness: 100,
    words,
  };
}

describe("weakestSyllable", () => {
  it("finds the worst syllable across every word, not just the worst word", () => {
    // A word can score respectably while containing the one bad syllable —
    // averaging hides exactly what the learner needs.
    const result = scored([
      word("Bonjour", [syllable("bon", 100), syllable("jour", 93)]),
      word("comment", [syllable("com", 100), syllable("ment", 61)]),
    ]);

    expect(weakestSyllable(result)?.syllable.grapheme).toBe("ment");
    expect(weakestSyllable(result)?.word).toBe("comment");
  });

  it("says nothing when every syllable is already good", () => {
    const result = scored([word("Bonjour", [syllable("bon", 96), syllable("jour", 88)])]);

    expect(weakestSyllable(result)).toBeNull();
  });

  it("says nothing about an attempt that was never measured", () => {
    // R8: an indeterminate result carries no scores, so there is nothing to
    // advise on and inventing something would be worse than silence.
    const result: PronunciationResult = {
      indeterminate: true,
      provider: "azure",
      reason: "no speech found to assess",
    };

    expect(weakestSyllable(result)).toBeNull();
    expect(adviceFor(result)).toBeNull();
  });

  it("reports the position within its own word, not across the phrase", () => {
    // "part 2 of 2 in comment" is findable; "part 4 of 5" across a phrase is
    // arithmetic the learner has to do themselves.
    const result = scored([
      word("Bonjour", [syllable("bon", 100), syllable("jour", 95)]),
      word("comment", [syllable("com", 99), syllable("", 40)]),
    ]);

    const weakest = weakestSyllable(result);
    expect(weakest?.position).toBe(2);
    expect(weakest?.countInWord).toBe(2);
    expect(weakest?.word).toBe("comment");
  });

  it("copes with a word that has no syllables at all", () => {
    const result = scored([word("Bonjour", []), word("comment", [syllable("ment", 50)])]);

    expect(weakestSyllable(result)?.syllable.grapheme).toBe("ment");
  });
});

describe("adviceFor", () => {
  it("names the syllable and gives one thing to do", () => {
    const result = scored([word("comment", [syllable("com", 100), syllable("ment", 61)])]);

    const advice = adviceFor(result);
    expect(advice).toContain("ment");
    expect(advice).toContain("comment");
    expect(advice).toContain("61");
    expect(advice).toMatch(/slowly/i);
  });

  it("falls back to position where the language has no written form", () => {
    // Hindi: 0 of 108 syllables named, every one scored. Position is the only
    // handle available, and it is a real one rather than a degraded label.
    const result = scored([word("नमस्ते", [syllable("", 90), syllable("", 44), syllable("", 95)])]);

    const advice = adviceFor(result);
    expect(advice).toContain("part 2 of 3");
    expect(advice).toContain("44");
    // Offers the thing that does work there: hearing it back.
    expect(advice).toMatch(/hear how you said it/i);
  });

  it("uses no phonetic notation, which most learners cannot read", () => {
    const result = scored([word("comment", [syllable("ment", 61)])]);

    // The activity's own focus text says "/ɔ̃/ and /ɑ̃/". That is the thing
    // this deliberately does not do.
    expect(adviceFor(result)).not.toMatch(/[ɐ-ʯ]|\//);
  });

  it("stays silent on a clean take rather than manufacturing a note", () => {
    const result = scored([word("Bonjour", [syllable("bon", 98), syllable("jour", 91)])]);

    expect(adviceFor(result)).toBeNull();
  });

  it("singles out one syllable, not a list", () => {
    // A learner about to re-record can hold one thing in mind. Three is a
    // report, and the report already exists.
    const result = scored([
      word("comment", [syllable("com", 30), syllable("ment", 40)]),
      word("allez", [syllable("al", 20), syllable("lez", 35)]),
    ]);

    const advice = adviceFor(result) ?? "";
    expect(advice).toContain("al");
    expect(advice).not.toContain("ment");
  });
});
