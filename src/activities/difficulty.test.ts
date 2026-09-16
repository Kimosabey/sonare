/**
 * N7 — the L1 difficulty table, complete for every shipped pair.
 *
 * "Complete" is the checkable half and it is the only half a test can reach.
 * Whether /ʁ/ really comes out as an English r, and whether the advice for it
 * is good advice, is a claim about phonetics that a linguist has to check —
 * the file says so. What is asserted here is that the table covers every pair
 * the product actually ships, and that every difficulty in it is attached to a
 * syllable the content actually drills.
 *
 * That second one is the assertion worth having. A difficulty naming a
 * syllable no activity exercises is advice a learner can never be given: it
 * looks like coverage, reads like coverage in review, and reaches nobody.
 */

import { describe, expect, it } from "vitest";
import { L1_DIFFICULTY, adviceForGrapheme, difficultiesFor, pairKey } from "./difficulty.js";
import { LANGUAGES } from "./languages/index.js";
import { COURSES } from "./courses/index.js";

/** English is the only first language the product assumes — see the file. */
const L1 = "en";

/** Every syllable the shipped content drills, per locale. */
function drilledSyllables(code: string): Set<string> {
  const sets = [...LANGUAGES, ...COURSES].filter((set) => set.code === code);
  const found = new Set<string>();
  for (const set of sets) {
    for (const activity of set.activities) {
      for (const sound of activity.soundTargets ?? []) found.add(sound);
    }
  }
  return found;
}

describe("the table covers what the product ships", () => {
  it("has an entry for every offered language", () => {
    expect(LANGUAGES.length).toBeGreaterThan(0);

    for (const language of LANGUAGES) {
      const entries = difficultiesFor(L1, language.code);
      expect(entries.length, `${language.label} (${pairKey(L1, language.code)})`).toBeGreaterThan(0);
    }
  });

  /**
   * And nothing else. A pair for a language nobody can open is a claim about
   * learners who do not exist, and it would quietly stop being checked against
   * content the moment that language stopped shipping.
   */
  it("has no entry for a pair the product does not ship", () => {
    const offered = new Set(LANGUAGES.map((l) => pairKey(L1, l.code)));

    for (const key of Object.keys(L1_DIFFICULTY)) {
      expect(offered.has(key), `${key} is in the table but not offered`).toBe(true);
    }
  });
});

describe("every difficulty is reachable", () => {
  /**
   * The one that stops this being decoration. A difficulty attached to a
   * syllable no activity drills is advice that can never be shown — it reads
   * as coverage and delivers none.
   */
  it("names only syllables the content actually drills", () => {
    for (const language of LANGUAGES) {
      const drilled = drilledSyllables(language.code);
      expect(drilled.size, `${language.label} drills nothing`).toBeGreaterThan(0);

      for (const entry of difficultiesFor(L1, language.code)) {
        for (const grapheme of entry.graphemes) {
          expect(drilled.has(grapheme), `${language.label}: “${grapheme}” (${entry.ipa})`).toBe(
            true,
          );
        }
      }
    }
  });

  it("gives every difficulty at least one syllable to attach to", () => {
    for (const language of LANGUAGES) {
      for (const entry of difficultiesFor(L1, language.code)) {
        expect(entry.graphemes.length, `${language.label}: ${entry.ipa}`).toBeGreaterThan(0);
      }
    }
  });

  it("does not attach one syllable to two different difficulties", () => {
    for (const language of LANGUAGES) {
      const seen = new Map<string, string>();
      for (const entry of difficultiesFor(L1, language.code)) {
        for (const grapheme of entry.graphemes) {
          const already = seen.get(grapheme);
          expect(already, `${language.label}: “${grapheme}” is ${already} and ${entry.ipa}`).toBe(
            undefined,
          );
          seen.set(grapheme, entry.ipa);
        }
      }
    }
  });
});

describe("what each entry says", () => {
  it("names a substitution and an action, not just a sound", () => {
    for (const language of LANGUAGES) {
      for (const entry of difficultiesFor(L1, language.code)) {
        const where = `${language.label}: ${entry.ipa}`;
        expect(entry.substitution.trim().length, where).toBeGreaterThan(0);
        expect(entry.advice.trim().length, where).toBeGreaterThan(0);
        // A full sentence, because "further back" on its own is not an action.
        expect(entry.advice.trim().endsWith("."), where).toBe(true);
      }
    }
  });

  /**
   * The advice is read by a learner mid-practice, not by a phonetician. IPA
   * belongs in `ipa`, where anyone who wants precision can find it.
   */
  it("keeps phonetic notation out of the advice a learner reads", () => {
    for (const language of LANGUAGES) {
      for (const entry of difficultiesFor(L1, language.code)) {
        expect(entry.advice, `${language.label}: ${entry.ipa}`).not.toMatch(/\/[^/]+\//);
      }
    }
  });
});

describe("looking one up", () => {
  it("finds a difficulty by the syllable the scorer names", () => {
    const french = LANGUAGES.find((l) => l.slug === "fr");
    expect(french).toBeDefined();
    if (!french) return;

    const found = adviceForGrapheme(L1, french.code, "jour");
    expect(found?.ipa).toBe("/ʁ/");
  });

  it("folds case, because the skills store keys lower", () => {
    const french = LANGUAGES.find((l) => l.slug === "fr");
    if (!french) return;

    expect(adviceForGrapheme(L1, french.code, "JOUR")?.ipa).toBe("/ʁ/");
  });

  /**
   * Null rather than something generic. Most syllables are not difficult, and
   * advice attached to one a learner already says well is noise that buries
   * the advice that matters.
   */
  it("says nothing about a syllable with no recorded difficulty", () => {
    const french = LANGUAGES.find((l) => l.slug === "fr");
    if (!french) return;

    expect(adviceForGrapheme(L1, french.code, "not-a-syllable")).toBeNull();
  });

  it("says nothing for a language with no table", () => {
    expect(difficultiesFor(L1, "de-DE")).toEqual([]);
    expect(adviceForGrapheme(L1, "de-DE", "chen")).toBeNull();
  });
});
