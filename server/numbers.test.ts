/**
 * Spoken numbers against transcribed digits.
 *
 * Every case in the first group is a real take from the trail on disk. Azure
 * transcribes numbers as digits, so a learner who said "trente-deux" perfectly
 * was told they had dropped a word and substituted another. Three of the forty
 * shipped activities contain a cardinal number, so this is live content.
 *
 * The languages disagree about how a number is built, and each of them
 * disagrees in a way that breaks a naive additive reader: French multiplies
 * ("quatre-vingt" is four twenties), German writes the whole thing as one word
 * with the unit first ("siebenundvierzig"), Spanish joins with a word and
 * spells its twenties as one token, and Hindi has no composition at all.
 */

import { describe, expect, it } from "vitest";
import { collapseNumbers, canonicalNumber, isCanonicalNumber } from "./numbers.js";
import { alignSpoken, tokenise } from "./alignment.js";

/** The canonical tokens a phrase collapses to. */
function collapsed(text: string, language: string): string[] {
  const words = tokenise(text);
  return collapseNumbers(words, words, language).tokens;
}

describe("the real takes this was built for", () => {
  it("matches trente-deux against 32", () => {
    // "Il y a trente-deux étudiants dans la classe" → "Il y a 32 étudiants
    // dans la classe." Previously one missing word plus one substitution.
    const result = alignSpoken(
      "Il y a trente-deux étudiants dans la classe",
      "Il y a 32 étudiants dans la classe",
      "fr-FR",
    );

    expect(result.missing).toBe(0);
    expect(result.substituted).toBe(0);
    expect(result.numericForms).toBe(0);
    expect(result.wordCoverage).toBe(1);
  });

  it("matches three against 3", () => {
    const result = alignSpoken("three", "3", "en-US");

    expect(result.matched).toBe(1);
    expect(result.numericForms).toBe(0);
  });

  it("matches the shipped French activity", () => {
    // "Il y a quarante-deux personnes à la réunion" — the one numeric French
    // target, and the reason this module exists rather than a lookup.
    const result = alignSpoken(
      "Il y a quarante-deux personnes à la réunion",
      "Il y a 42 personnes à la réunion",
      "fr-FR",
    );

    expect(result.missing).toBe(0);
    expect(result.wordCoverage).toBe(1);
  });

  it("matches the shipped German activity", () => {
    // "Es sind siebenundvierzig Gäste auf der Party" — one word, unit first.
    const result = alignSpoken(
      "Es sind siebenundvierzig Gäste auf der Party",
      "Es sind 47 Gäste auf der Party",
      "de-DE",
    );

    expect(result.missing).toBe(0);
    expect(result.substituted).toBe(0);
  });

  it("matches the shipped Spanish activity", () => {
    // "Hay cuarenta y cuatro invitados en la boda" — three tokens, one number.
    const result = alignSpoken(
      "Hay cuarenta y cuatro invitados en la boda",
      "Hay 44 invitados en la boda",
      "es-ES",
    );

    expect(result.missing).toBe(0);
    expect(result.substituted).toBe(0);
  });

  it("matches the shipped Hindi activity", () => {
    // "मुझे एक चाय और एक समोसा चाहिए" — एक is one, twice.
    const result = alignSpoken("मुझे एक चाय और एक समोसा चाहिए", "मुझे 1 चाय और 1 समोसा चाहिए", "hi-IN");

    expect(result.missing).toBe(0);
    expect(result.substituted).toBe(0);
  });
});

describe("French, which multiplies", () => {
  it("reads quatre-vingt as eighty, not twenty-four", () => {
    /**
     * The rule a purely additive reader gets wrong, and it is not obscure:
     * every French number from 80 to 99 is built this way.
     */
    expect(collapsed("quatre-vingt", "fr-FR")).toEqual([canonicalNumber(80)]);
    expect(collapsed("quatre-vingt-dix", "fr-FR")).toEqual([canonicalNumber(90)]);
    expect(collapsed("quatre-vingt-dix-neuf", "fr-FR")).toEqual([canonicalNumber(99)]);
  });

  it("still reads a bare vingt as twenty", () => {
    // The multiplier only applies after a unit of two to nine, so "vingt" and
    // "vingt et un" are unaffected.
    expect(collapsed("vingt", "fr-FR")).toEqual([canonicalNumber(20)]);
    expect(collapsed("vingt-et-un", "fr-FR")).toEqual([canonicalNumber(21)]);
  });

  it("reads the seventies additively", () => {
    expect(collapsed("soixante-dix", "fr-FR")).toEqual([canonicalNumber(70)]);
    expect(collapsed("soixante-quinze", "fr-FR")).toEqual([canonicalNumber(75)]);
  });

  it("reads the teens built from dix", () => {
    // Tokenised as two words, since the hyphen is a boundary.
    expect(collapsed("dix-sept", "fr-FR")).toEqual([canonicalNumber(17)]);
    expect(collapsed("dix-neuf", "fr-FR")).toEqual([canonicalNumber(19)]);
  });

  it("does not swallow the sentence's own et", () => {
    /**
     * "et" joins parts of a number *and* joins clauses. "Il fait froid et il
     * pleut" must not read "froid et il" as anything numeric, and a greedy run
     * would take the connector and then fail.
     */
    expect(collapsed("Il y a trente-deux personnes et il pleut", "fr-FR")).toEqual([
      "il", "y", "a", canonicalNumber(32), "personnes", "et", "il", "pleut",
    ]);
  });
});

describe("German, which writes it as one word", () => {
  it("takes a compound apart, unit first", () => {
    expect(collapsed("siebenundvierzig", "de-DE")).toEqual([canonicalNumber(47)]);
    expect(collapsed("einundzwanzig", "de-DE")).toEqual([canonicalNumber(21)]);
    expect(collapsed("neunundneunzig", "de-DE")).toEqual([canonicalNumber(99)]);
  });

  it("reads a plain ten and a plain unit", () => {
    expect(collapsed("vierzig", "de-DE")).toEqual([canonicalNumber(40)]);
    expect(collapsed("neun", "de-DE")).toEqual([canonicalNumber(9)]);
  });

  it("does not mistake an ordinary word containing und", () => {
    // "und" is the commonest word in German. Only a token that splits into a
    // real unit and a real ten is a number.
    expect(collapsed("und", "de-DE")).toEqual(["und"]);
    expect(collapsed("Gesundheit", "de-DE")).toEqual(["gesundheit"]);
  });
});

describe("Spanish and Hindi", () => {
  it("joins Spanish tens and units with y", () => {
    expect(collapsed("cuarenta y cuatro", "es-ES")).toEqual([canonicalNumber(44)]);
    expect(collapsed("noventa y nueve", "es-ES")).toEqual([canonicalNumber(99)]);
  });

  it("reads the Spanish twenties, which are one word", () => {
    expect(collapsed("veintitres", "es-ES")).toEqual([canonicalNumber(23)]);
  });

  it("reads Hindi numbers from a list, because there is nothing to compose", () => {
    // Every Hindi number is its own irregular word. The table is deliberately
    // partial and anything outside it falls back to unchecked.
    expect(collapsed("एक", "hi-IN")).toEqual([canonicalNumber(1)]);
    expect(collapsed("बीस", "hi-IN")).toEqual([canonicalNumber(20)]);
  });

  it("reads Devanagari digits", () => {
    // A Hindi transcript can use them.
    expect(collapsed("३२", "hi-IN")).toEqual([canonicalNumber(32)]);
    expect(alignSpoken("बीस", "२०", "hi-IN").matched).toBe(1);
  });
});

describe("what it refuses to guess", () => {
  it("leaves a time expression unchecked", () => {
    /**
     * "Huit heures et quart" against "08h15" is not a number comparison — "et
     * quart" means fifteen minutes, which is semantics about clocks. One real
     * take is this case, and it stays unchecked rather than guessed at.
     */
    const result = alignSpoken("Le train part à huit heures et quart", "Le train part à 08h15", "fr-FR");

    expect(result.numericForms).toBe(1);
    expect(result.substituted).toBe(0);
  });

  it("leaves anything above a hundred unchecked", () => {
    // The composition rules diverge again above 100 and nothing needs them,
    // so it refuses rather than returning a number nobody checked.
    expect(collapsed("250", "fr-FR")).toEqual(["250"]);
  });

  it("does nothing at all without a language", () => {
    // The route always has one; the fallback has to be a no-op rather than a
    // guess at which language a phrase is in.
    expect(collapsed("trente-deux", "")).toEqual(["trente", "deux"]);
    expect(alignSpoken("trente-deux", "32").numericForms).toBeGreaterThan(0);
  });

  it("does nothing for a language it has no table for", () => {
    expect(collapsed("trettiotva", "sv-SE")).toEqual(["trettiotva"]);
  });

  it("still reports a genuine number mismatch as a fault", () => {
    /**
     * The guard must not swallow real errors. A learner who says forty-three
     * where forty-two was asked has substituted a word, and now that both
     * sides parse, the alignment can finally say so instead of shrugging.
     */
    const result = alignSpoken("quarante-deux personnes", "43 personnes", "fr-FR");

    expect(result.substituted).toBe(1);
    expect(result.numericForms).toBe(0);
  });

  it("reports a missing number as missing", () => {
    const result = alignSpoken("Il y a quarante-deux personnes", "Il y a personnes", "fr-FR");

    expect(result.missing).toBe(1);
  });
});

describe("display", () => {
  it("keeps what was written, not the canonical form", () => {
    /**
     * The chip a learner sees has to say "quarante-deux", not "#42". The
     * canonical token exists only so the two forms compare as one word.
     */
    const result = alignSpoken("quarante-deux personnes", "42 personnes", "fr-FR");

    expect(result.tokens[0]?.expected).toBe("quarante-deux");
    expect(result.tokens[0]?.status).toBe("match");
  });

  it("marks a canonical token as one", () => {
    expect(isCanonicalNumber(canonicalNumber(42))).toBe(true);
    expect(isCanonicalNumber("quarante")).toBe(false);
  });
});
