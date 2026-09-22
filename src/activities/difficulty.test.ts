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
  it("has an entry for every offered language that declares sounds", () => {
    /**
     * Scoped to languages whose content actually names syllables, because one
     * does not and cannot.
     *
     * Hindi ships with no `soundTargets` at all: the provider returns no
     * syllable graphemes for Devanagari — 0 of 108 across its ten targets —
     * so there is nothing for advice to attach to. An entry here would have to
     * name syllables the content does not drill, which the very next test in
     * this file refuses, correctly.
     *
     * So the rule is "advice for every sound a learner can be told about",
     * and a language that can name none is outside it rather than failing it.
     * The absence is a fact about the scorer, not an oversight to fill.
     */
    for (const language of LANGUAGES) {
      const declaresSounds = language.activities.some(
        (activity) => (activity.soundTargets?.length ?? 0) > 0,
      );
      if (!declaresSounds) continue;

      expect(
        difficultiesFor(L1, language.code).length,
        `${language.label} (${L1}→${language.code})`,
      ).toBeGreaterThan(0);
    }
  });

  /**
   * And the exclusion is real rather than a way to pass — it names which
   * languages, so widening it is a deliberate edit somebody makes.
   *
   * It widened once already, the day after it was written: Kannada shipped and
   * the guard failed, which is exactly what it is for. Both are Indic scripts
   * the provider segments into words and not syllables — 0 of 108 named for
   * Devanagari, 0 of 0 for Kannada — so both give a learner a score with
   * positional feedback rather than a named sound.
   *
   * A third arriving should be looked at rather than waved through. Two is a
   * property of one provider's coverage; three starts to be a claim about what
   * this product can honestly teach.
   */
  it("names every language that can identify no sounds", () => {
    const silent = LANGUAGES.filter(
      (language) => !language.activities.some((a) => (a.soundTargets?.length ?? 0) > 0),
    );

    expect(silent.map((l) => l.code).sort()).toEqual(["hi-IN", "kn-IN"]);
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
      /**
       * A language that drills nothing has no difficulties to check, and
       * asserting otherwise is asserting that Devanagari has syllables the
       * scorer can name. Hindi is the one, and the test above pins it as
       * exactly one so this cannot quietly widen.
       */
      if (drilled.size === 0) {
        expect(difficultiesFor(L1, language.code), `${language.label}`).toEqual([]);
        continue;
      }

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

  /**
   * Hindi rather than German, which used to stand here and now has a table of
   * its own. The example has to be a locale that genuinely has none, or this
   * asserts nothing — and hi-IN will stay that way for as long as the scorer
   * names no syllables in it to attach advice to.
   */
  it("says nothing for a language with no table", () => {
    expect(difficultiesFor(L1, "hi-IN")).toEqual([]);
    expect(adviceForGrapheme(L1, "hi-IN", "chen")).toBeNull();
  });
});
