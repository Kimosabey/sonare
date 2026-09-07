/**
 * Keeping the learner's history while letting the take expire.
 *
 * `attempts` has a 90-day TTL because it holds a spoken phrase, device context
 * and a session id. The syllable accuracies inside are a different kind of
 * data — the learner's own record — and the product's distinctive claim
 * ("‑ent is at 61, up from 48 last week") needs them for longer than that.
 *
 * So the interesting cases here are about *what not to keep*: nothing from an
 * indeterminate take, nothing from an unnamed syllable, and nothing at all
 * rather than an empty record that would read as "this learner has no sounds".
 */

import { describe, expect, it, vi } from "vitest";
import { rollupSkills, slugForLanguage } from "./rollup.js";
import type { PronunciationResult } from "../services/types.js";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const AT = "2026-09-07T10:00:00.000Z";

function syllable(grapheme: string, accuracy: number) {
  return { grapheme, accuracy, offsetTicks: 0, durationTicks: 1_000_000 };
}

function scored(words: Array<{ word: string; syllables: ReturnType<typeof syllable>[] }>): PronunciationResult {
  return {
    indeterminate: false,
    provider: "azure",
    recognized: words.map((w) => w.word).join(" "),
    overall: 80,
    accuracy: 80,
    fluency: 80,
    completeness: 100,
    words: words.map((w) => ({
      word: w.word,
      accuracy: 80,
      errorType: "None",
      phonemes: [],
      syllables: w.syllables,
    })),
  } as PronunciationResult;
}

describe("mapping a language to its content slug", () => {
  it("maps every language that ships", () => {
    expect(slugForLanguage("fr-FR")).toBe("fr");
    expect(slugForLanguage("es-ES")).toBe("es");
    expect(slugForLanguage("de-DE")).toBe("de");
    expect(slugForLanguage("hi-IN")).toBe("hi");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(slugForLanguage("  fr-fr ")).toBe("fr");
  });

  it("guesses the primary subtag for an unknown language, and says so", async () => {
    /**
     * Explicit rather than assumed, because the guess stops being right the
     * moment two variants of one language ship: pt-BR and pt-PT would collapse
     * into a single history describing neither learner's sounds. The guess
     * keeps a new language working; the warning is what stops it being silent.
     */
    const { logger } = await import("../logger.js");

    expect(slugForLanguage("pt-BR")).toBe("pt");
    expect(logger.warn).toHaveBeenCalled();
  });

  it("returns nothing for something that is not a language tag", () => {
    expect(slugForLanguage("")).toBeNull();
    expect(slugForLanguage("!!")).toBeNull();
    expect(slugForLanguage("123-45")).toBeNull();
  });
});

describe("what is kept", () => {
  it("keeps a named syllable's accuracy", () => {
    const state = rollupSkills(scored([{ word: "bonjour", syllables: [syllable("bon", 88)] }]), "fr-FR", AT);

    expect(state?.slug).toBe("fr");
    expect(state?.skills).toEqual([{ grapheme: "bon", samples: [{ at: AT, accuracy: 88 }] }]);
  });

  it("keeps every syllable across every word", () => {
    const state = rollupSkills(
      scored([
        { word: "bonjour", syllables: [syllable("bon", 88), syllable("jour", 61)] },
        { word: "comment", syllables: [syllable("com", 70), syllable("ment", 45)] },
      ]),
      "fr-FR",
      AT,
    );

    expect(state?.skills.map((s) => s.grapheme).sort()).toEqual(["bon", "com", "jour", "ment"]);
  });

  it("keeps both readings when a phrase repeats a syllable", () => {
    /**
     * They share the take's timestamp, and the sync merge deduplicates samples
     * on exactly that — so without distinct times one of the two would be
     * silently discarded and the syllable would look practised half as often
     * as it was.
     */
    const state = rollupSkills(
      scored([
        { word: "maman", syllables: [syllable("ma", 40), syllable("man", 90)] },
        { word: "matin", syllables: [syllable("ma", 80)] },
      ]),
      "fr-FR",
      AT,
    );

    const ma = state?.skills.find((s) => s.grapheme === "ma");
    expect(ma?.samples).toHaveLength(2);
    expect(ma?.samples.map((s) => s.accuracy).sort((a, b) => a - b)).toEqual([40, 80]);
    // Distinct timestamps, so neither is dropped as a duplicate.
    expect(new Set(ma?.samples.map((s) => s.at)).size).toBe(2);
  });

  it("produces the same timestamps when the same take is rolled twice", () => {
    // Derived from the take's own time rather than the clock, so re-rolling is
    // idempotent against the union rather than adding a second copy.
    const take = scored([{ word: "maman", syllables: [syllable("ma", 40), syllable("man", 90)] }]);

    expect(rollupSkills(take, "fr-FR", AT)).toEqual(rollupSkills(take, "fr-FR", AT));
  });
});

describe("what is refused", () => {
  it("keeps nothing from an indeterminate take", () => {
    /**
     * R8 makes indeterminate the honest answer for unusable audio. Rolling
     * anything up from it would invent a measurement for a take the system
     * explicitly declined to judge — and that invented number would then be
     * averaged into what the learner is told about their own pronunciation.
     */
    const indeterminate = {
      indeterminate: true,
      provider: "azure",
      reason: "NO_SPEECH_DETECTED",
      words: [],
    } as unknown as PronunciationResult;

    expect(rollupSkills(indeterminate, "fr-FR", AT)).toBeNull();
  });

  it("drops an unnamed syllable rather than pooling it", () => {
    /**
     * Azure returns an empty grapheme where it could not map one — always for
     * Hindi, and around elision and hyphenation in French. Pooled, every one
     * of those lands in a single "" bucket that then gets presented to the
     * learner as their weakest sound.
     */
    const state = rollupSkills(
      scored([{ word: "बहुत", syllables: [syllable("", 30), syllable("", 40)] }]),
      "hi-IN",
      AT,
    );

    expect(state).toBeNull();
  });

  it("keeps the named syllables of a partly-unnamed word", () => {
    const state = rollupSkills(
      scored([{ word: "l'ami", syllables: [syllable("", 30), syllable("ami", 75)] }]),
      "fr-FR",
      AT,
    );

    expect(state?.skills).toEqual([{ grapheme: "ami", samples: [{ at: AT, accuracy: 75 }] }]);
  });

  it("returns nothing rather than an empty record", () => {
    // An empty state would write a document saying "this learner has no
    // sounds", which is a different claim from having nothing to add.
    expect(rollupSkills(scored([]), "fr-FR", AT)).toBeNull();
    expect(rollupSkills(scored([{ word: "x", syllables: [] }]), "fr-FR", AT)).toBeNull();
  });

  it("keeps nothing when the language cannot be mapped", () => {
    expect(rollupSkills(scored([{ word: "x", syllables: [syllable("x", 50)] }]), "!!", AT)).toBeNull();
  });

  it("survives a result with no words array at all", () => {
    // Records written by an older build, replayed through the fallback log.
    const sparse = { indeterminate: false, provider: "azure" } as unknown as PronunciationResult;

    expect(rollupSkills(sparse, "fr-FR", AT)).toBeNull();
  });

  it("clamps an impossible accuracy on the way in", () => {
    const state = rollupSkills(scored([{ word: "x", syllables: [syllable("bon", 900)] }]), "fr-FR", AT);

    expect(state?.skills[0]?.samples[0]?.accuracy).toBe(100);
  });

  it("case-folds, so one sound keeps one history", () => {
    const state = rollupSkills(
      scored([{ word: "Bonjour", syllables: [syllable("Bon", 88), syllable("bon", 60)] }]),
      "fr-FR",
      AT,
    );

    expect(state?.skills).toHaveLength(1);
    expect(state?.skills[0]?.samples).toHaveLength(2);
  });
});
