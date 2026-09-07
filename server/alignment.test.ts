/**
 * Expected versus heard, and the three cases Azure's own verdict cannot cover.
 *
 * The first test is the example this module was asked for by name. It is worth
 * stating plainly that Azure already handles it — 57 omissions across the 401
 * words on disk — so the case is here as a floor, not as the justification.
 * The justification is substitution as a single event, repeated words, and
 * having a second opinion at all.
 */

import { describe, expect, it } from "vitest";
import { alignSpoken, normaliseWord, tokenise } from "./alignment.js";

/** Statuses in reference order, for reading an alignment at a glance. */
function shape(expected: string, heard: string): string[] {
  return alignSpoken(expected, heard).tokens.map((t) =>
    t.status === "substituted" ? `substituted(${t.heard ?? ""})` : t.status,
  );
}

describe("the case this exists to answer", () => {
  it("finds the one dropped word in the middle of a phrase", () => {
    /**
     * Expected "Bonjour, comment allez-vous" against heard "Bonjour, comment
     * vous": bonjour present, comment present, allez missing, vous present.
     * The hyphen is a word boundary, which is why this is four words and not
     * three.
     */
    const result = alignSpoken("Bonjour, comment allez-vous", "Bonjour, comment vous");

    expect(result.tokens.map((t) => t.expected)).toEqual(["Bonjour", "comment", "allez", "vous"]);
    expect(result.tokens.map((t) => t.status)).toEqual(["match", "match", "missing", "match"]);
    expect(result.missing).toBe(1);
    expect(result.matched).toBe(3);
    expect(result.extras).toEqual([]);
  });

  it("reports a perfect repetition as nothing wrong", () => {
    const result = alignSpoken("Bonjour, comment allez-vous ?", "bonjour comment allez vous");

    expect(result.missing).toBe(0);
    expect(result.substituted).toBe(0);
    expect(result.extras).toEqual([]);
    expect(result.wordCoverage).toBe(1);
  });
});

describe("substitution — one event, not two", () => {
  it("pairs a swapped word instead of reporting a miss and an extra", () => {
    /**
     * The first thing Azure cannot do: it has no Substitution error type, so a
     * swap arrives as an omission plus an insertion with nothing linking them,
     * and the report says two things went wrong where one did.
     *
     * Unit costs are what buy this — a substitution costs 1 against 2 for a
     * delete plus an insert, so the alignment prefers to call it one event.
     */
    const result = alignSpoken("Je voudrais un croissant", "Je voudrais un café");

    expect(shape("Je voudrais un croissant", "Je voudrais un café")).toEqual([
      "match",
      "match",
      "match",
      "substituted(café)",
    ]);
    expect(result.substituted).toBe(1);
    expect(result.missing).toBe(0);
    expect(result.extra).toBe(0);
  });

  it("keeps the word actually said, for the learner to see", () => {
    // "You said X where Y was expected" is actionable. "A word was wrong" is
    // not, and the transcript is the only place the said word exists.
    const result = alignSpoken("Il fait froid", "Il fait chaud");

    expect(result.tokens[2]).toMatchObject({ expected: "froid", status: "substituted", heard: "chaud" });
  });

  it("handles several substitutions in one phrase", () => {
    const result = alignSpoken("le film commence à neuf heures", "le film termine à dix heures");

    expect(result.substituted).toBe(2);
    expect(result.matched).toBe(4);
  });
});

describe("repeated words — a stumble, not a stray word", () => {
  it("marks a doubled word as repeated rather than extra", () => {
    /**
     * The second thing nothing detects anywhere. A learner who hesitates and
     * says a word twice has done something specific, and the advice differs
     * from a word that was never in the phrase: "you said that twice" against
     * "that word is not in this sentence".
     */
    const result = alignSpoken("Bonjour comment allez-vous", "Bonjour bonjour comment allez vous");

    expect(result.extras).toHaveLength(1);
    // Raw spelling, not the comparison form — this string is shown to a learner.
    expect(result.extras[0]).toMatchObject({ heard: "Bonjour", repeated: true });
    expect(result.repeated).toBe(1);
    expect(result.extra).toBe(0);
    // Nothing was actually missed — the phrase is all there.
    expect(result.missing).toBe(0);
  });

  it("distinguishes a repetition from a genuinely new word", () => {
    const stumble = alignSpoken("je voudrais un café", "je je voudrais un café");
    const intrusion = alignSpoken("je voudrais un café", "je voudrais vraiment un café");

    expect(stumble.repeated).toBe(1);
    expect(stumble.extra).toBe(0);
    expect(intrusion.repeated).toBe(0);
    expect(intrusion.extra).toBe(1);
    expect(intrusion.extras[0]).toMatchObject({ heard: "vraiment", repeated: false });
  });

  it("counts a word said three times as two repetitions", () => {
    const result = alignSpoken("bonjour", "bonjour bonjour bonjour");

    expect(result.repeated).toBe(2);
    expect(result.matched).toBe(1);
  });

  it("does not call a word repeated when the phrase itself repeats it", () => {
    /**
     * "à la prochaine à bientôt" legitimately says "à" twice. A learner who
     * says it correctly must not be told they stumbled — the repetition is
     * only an extra if the reference did not ask for it.
     */
    const result = alignSpoken("à la prochaine à bientôt", "à la prochaine à bientôt");

    expect(result.repeated).toBe(0);
    expect(result.extras).toEqual([]);
    expect(result.matched).toBe(5);
  });

  it("places an extra where it was heard, not in a list at the end", () => {
    // So the UI can show it in position. A list at the end would leave the
    // learner working out where in the phrase it happened.
    const result = alignSpoken("un deux trois", "un deux quatre trois");

    expect(result.extras[0]?.afterExpectedIndex).toBe(2);
  });
});

describe("normalisation", () => {
  it("ignores case and the punctuation a reference carries", () => {
    // Activity targets are written for a human to read: commas, question
    // marks, capitals. None of it is something a learner can pronounce wrong.
    expect(tokenise("Bonjour, comment allez-vous ?")).toEqual(["bonjour", "comment", "allez", "vous"]);
  });

  it("treats hyphens and apostrophes as word boundaries", () => {
    /**
     * Both are word boundaries in the languages shipped. "allez-vous" is two
     * words a learner can get separately right or wrong, and one token would
     * report a single failure for a correct "allez" and a missed "vous".
     * Curly and straight apostrophes both, since content and transcripts
     * disagree about which they use.
     */
    expect(tokenise("Je m'appelle Marie")).toEqual(["je", "m", "appelle", "marie"]);
    // "plaît" arrives as "plait" — tokenise folds accents, by design.
    expect(tokenise("L’addition s’il vous plaît")).toEqual([
      "l",
      "addition",
      "s",
      "il",
      "vous",
      "plait",
    ]);
    expect(tokenise("quarante-deux")).toEqual(["quarante", "deux"]);
  });

  it("folds accents, because a missing acute is not a mispronunciation", () => {
    // The reference is written with them and a transcript may not be.
    expect(normaliseWord("café")).toBe(normaliseWord("cafe"));
    expect(normaliseWord("PLAÎT")).toBe(normaliseWord("plait"));
    expect(alignSpoken("un café", "un cafe").matched).toBe(2);
  });

  it("leaves Devanagari intact", () => {
    /**
     * The reason accent folding strips only the combining-marks block instead
     * of flattening NFD wholesale. Devanagari matras are separate code points
     * that carry the vowel — removing them turns नमस्ते into a different word
     * and makes every Hindi comparison a mismatch. Hindi is a quarter of the
     * shipped languages and the one with no syllable names, so it can least
     * afford a broken word verdict.
     */
    const result = alignSpoken("नमस्ते आप कैसे हैं", "नमस्ते आप कैसे हैं");

    expect(result.matched).toBe(4);
    expect(result.missing).toBe(0);
    expect(normaliseWord("नमस्ते")).toBe("नमस्ते");
  });

  it("keeps German umlauts comparable both ways round", () => {
    // "Guten Morgen, wie geht es Ihnen" — a transcript may write "Ihnen" or
    // an unaccented variant of a word elsewhere in the set.
    expect(alignSpoken("schön", "schon").matched).toBe(1);
    expect(alignSpoken("Grüße", "Grüße").matched).toBe(1);
  });

  it("collapses the whitespace real content carries", () => {
    // Targets come from content files, and double spaces after punctuation
    // are ordinary.
    expect(tokenise("  Bonjour,   comment  allez-vous  ")).toEqual([
      "bonjour",
      "comment",
      "allez",
      "vous",
    ]);
  });

  it("drops a token that was only punctuation", () => {
    // Azure returns "." as the display text for silence. It is not a word.
    expect(tokenise("...")).toEqual([]);
    expect(tokenise("¿ Cómo está usted ?")).toEqual(["como", "esta", "usted"]);
  });
});

describe("the honest edges", () => {
  it("reports every word missing when nothing was heard", () => {
    /**
     * The input for a take that produced no speech. Every reference word is
     * missing, which is true — and the caller decides whether to show it,
     * because an indeterminate take must not be presented to a learner as a
     * wrong answer. R8 lives at the call site, not here.
     */
    const result = alignSpoken("Bonjour comment allez-vous", "");

    expect(result.missing).toBe(4);
    expect(result.matched).toBe(0);
    expect(result.wordCoverage).toBe(0);
    expect(result.extras).toEqual([]);
  });

  it("reports everything as extra when there was nothing to say", () => {
    const result = alignSpoken("", "bonjour comment");

    expect(result.tokens).toEqual([]);
    expect(result.extras).toHaveLength(2);
    expect(result.extra).toBe(2);
    expect(result.repeated).toBe(0);
  });

  it("still calls a doubled word repeated with no reference at all", () => {
    // Repetition is a property of what was said, not of the reference.
    const result = alignSpoken("", "bonjour bonjour");

    expect(result.repeated).toBe(2);
    expect(result.extra).toBe(0);
  });

  it("has no opinion at all on two empty strings", () => {
    const result = alignSpoken("", "");

    expect(result.tokens).toEqual([]);
    expect(result.extras).toEqual([]);
    expect(result.wordCoverage).toBeNull();
  });

  it("reports no coverage rather than zero for an empty reference", () => {
    /**
     * Null, not 0. Zero coverage says the learner got none of it right; there
     * was nothing to get right. The same distinction R8 draws about scores,
     * and the reason this field is not called a score.
     */
    expect(alignSpoken("", "anything").wordCoverage).toBeNull();
    expect(alignSpoken("bonjour", "").wordCoverage).toBe(0);
  });

  it("counts words and claims nothing about pronunciation", () => {
    /**
     * A learner can say every word in the right order and pronounce them
     * badly. Coverage of 1 is not a pass, and the field name has to keep
     * saying so — conflating word presence with pronunciation quality is the
     * mistake this whole product exists to avoid.
     */
    const result = alignSpoken("Bonjour comment allez-vous", "bonjour comment allez vous");

    expect(result.wordCoverage).toBe(1);
    expect(Object.keys(result)).not.toContain("score");
    expect(Object.keys(result)).not.toContain("accuracy");
  });
});

describe("longer phrases", () => {
  it("handles the longest shipped target with several faults at once", () => {
    /**
     * "Il fait très froid et il pleut beaucoup aujourd'hui" — ten words once
     * the elision is split, with a drop, a swap and a stumble in one take. The
     * stumble is kept clear of the drop on purpose; the case where they are
     * adjacent is genuinely ambiguous and is its own test below.
     */
    const expected = "Il fait très froid et il pleut beaucoup aujourd'hui";
    const heard = "il fait très froid froid et pleut beaucoup aujourd demain";

    const result = alignSpoken(expected, heard);

    expect(result.repeated).toBe(1); // "froid" twice
    expect(result.missing).toBe(1); // the second "il"
    expect(result.substituted).toBe(1); // "demain" for "hui"
    expect(result.tokens).toHaveLength(tokenise(expected).length);
    expect(result.matched + result.missing + result.substituted).toBe(result.tokens.length);
  });

  it("calls an ambiguous doubling a substitution, not a stumble", () => {
    /**
     * A property of unit costs, recorded because it is a real judgement the
     * module makes rather than an accident.
     *
     * Heard "il fait fait froid" against expected "il fait très froid": the
     * second "fait" sits exactly where "très" should be. That is two readings
     * of the same audio — a stumble on "fait" with "très" dropped, or "très"
     * pronounced so badly it transcribed as "fait". The first costs an insert
     * plus a delete (2), the second costs one substitution (1), so the
     * alignment takes the substitution.
     *
     * That is the better answer for a learner: it points at the word they
     * actually got wrong. It does mean a stumble adjacent to a drop is
     * reported as a mispronunciation, and Azure's own per-word verdict is the
     * second opinion worth checking it against — which is why both are stored.
     */
    const result = alignSpoken("il fait très froid", "il fait fait froid");

    expect(result.substituted).toBe(1);
    expect(result.repeated).toBe(0);
    expect(result.tokens[2]).toMatchObject({ expected: "très", status: "substituted", heard: "fait" });
  });

  it("accounts for every reference word exactly once, always", () => {
    /**
     * The invariant that makes the output safe to render as a row per word:
     * the token list is the reference, in order, with nothing dropped or
     * duplicated, no matter how badly the take went.
     */
    const cases: [string, string][] = [
      ["un deux trois", ""],
      ["un deux trois", "trois deux un"],
      ["un deux trois", "un un un un un"],
      ["un", "un deux trois quatre cinq"],
      ["a b c d e f g h", "h g f e d c b a"],
    ];

    for (const [expected, heard] of cases) {
      const result = alignSpoken(expected, heard);
      const words = tokenise(expected);

      expect(result.tokens.map((t) => t.expected.toLocaleLowerCase()), `${expected} / ${heard}`).toEqual(
        words,
      );
      expect(result.matched + result.missing + result.substituted).toBe(words.length);
    }
  });
});

describe("French typography", () => {
  it("splits on the no-break spaces French puts before punctuation", () => {
    /**
     * The activity targets are written the way French is typeset: a no-break
     * (U+00A0) or narrow no-break (U+202F) space before "?" and "!". A plain
     * space class leaves "vous ?" as a single token, so the last word of every
     * question would fail to match.
     */
    expect(tokenise("Bonjour, comment allez-vous ?")).toEqual([
      "bonjour",
      "comment",
      "allez",
      "vous",
    ]);
    expect(tokenise("Ça va !")).toEqual(["ca", "va"]);
    expect(alignSpoken("comment allez-vous ?", "comment allez vous").matched).toBe(3);
  });

  it("treats both apostrophe forms as the same boundary", () => {
    // Content files and transcripts disagree about straight versus curly, and
    // a learner cannot pronounce the difference.
    expect(tokenise("j'habite")).toEqual(tokenise("j’habite"));
  });

  it("treats the typographic dashes as boundaries too", () => {
    // An en dash in a content file should not weld two words together.
    expect(tokenise("allez–vous")).toEqual(["allez", "vous"]);
  });
});
