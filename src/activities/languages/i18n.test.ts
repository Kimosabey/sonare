/**
 * T39 — the four shipped languages as Unicode, not as strings.
 *
 * Sonare ships fr-FR, es-ES, de-DE and hi-IN, and one of those four is
 * written in a script nothing else in the product uses. That asymmetry has
 * already cost something once: Nunito covers Latin, Latin-Ext, Cyrillic and
 * Greek and no Devanagari, so every Hindi prompt fell past the brand font to
 * whatever the device happened to have — a different typeface on a good
 * device, tofu boxes on one without a Devanagari face. A quarter of the
 * shipped languages rendered unstyled, unnoticed because every machine it was
 * written on has the font. The typography half of that is checked in
 * scripts/i18n-typography.test.ts; this file checks the *content*.
 *
 * The other thing here is IPA. Phonetic notation is the one kind of text in
 * this product that is neither a language nor ASCII: `ʃ`, `ɔ̃`, `ə` and the
 * length mark `ː` all have to survive scoring, aggregation and storage
 * byte-for-byte, because a phoneme symbol is an identity — two symbols that
 * normalise together become one bucket in the report and the learner is told
 * about a sound that does not exist.
 *
 * **`ə` is a Unicode letter.** U+0259 LATIN SMALL LETTER SCHWA, general
 * category Ll. A test once asserted that it should be rejected by a
 * letter-based validator and that test was wrong — the symbol is a letter,
 * the validator was right, and the assertion below is the correct form of
 * that claim.
 *
 * DOM-free, like everything else under src/activities/: tsconfig.scripts.json
 * includes this directory so Node scripts can import the content sets, so
 * nothing here may touch browser storage or `window`. The storage round-trip
 * half of the IPA question therefore lives in src/i18n.test.tsx.
 */

import { describe, expect, it } from "vitest";
import { LANGUAGES, getLanguage } from "./index.js";
import { buildReport } from "../report.js";
import type { Activity, ActivityAttempt, ActivityProgress } from "../types.js";
import type { PronunciationResult, ScoredWord } from "../../speech/scoring/types.js";

/**
 * IPA that has to survive the whole path.
 *
 * Chosen to cover every awkward category rather than to be a plausible
 * inventory: letters from IPA Extensions, a modifier letter (`ː`, category
 * Lm, which is not a letter people expect to be one), a two-code-point
 * sequence with a combining mark, a tie bar, and both stress marks.
 */
const IPA_SYMBOLS: readonly string[] = [
  "ə", // ə  schwa — the one a test once wrongly rejected
  "ʃ", // ʃ  esh
  "ʒ", // ʒ  ezh
  "ŋ", // ŋ  eng
  "θ", // θ  theta
  "ð", // ð  eth
  "ʁ", // ʁ  uvular trill (French r)
  "ɥ", // ɥ  labial-palatal approximant (French "huit")
  "œ", // œ  open-mid front rounded
  "ɲ", // ɲ  palatal nasal (Spanish ñ)
  "ʈ", // ʈ  retroflex stop (Hindi ट)
  "ɖ", // ɖ  retroflex stop (Hindi ड)
  "ʱ", // ʱ  breathy-voice modifier (Hindi aspiration)
  "ː", // ː  length mark
  "ˈ", // ˈ  primary stress
  "ˌ", // ˌ  secondary stress
  "\u0254\u0303", // ɔ̃  nasal vowel: two code points, one sound
  "\u0251\u0303", // ɑ̃  the other French nasal
  "t\u0361\u0283", // t͡ʃ  affricate with a tie bar: three code points
];

/**
 * A scored result carrying one word per phoneme — each symbol **twice**.
 *
 * Twice because `report.ts` sets `MIN_OCCURRENCES = 2`: a sound seen once is
 * not worth advising on, so a symbol that appears once is filtered out and
 * every assertion about the returned list would then hold over an empty list.
 * That is the exact shape of a test that passes against a broken
 * implementation, and it is how the first draft of this file was wrong.
 */
function buildResult(phonemes: string[]): PronunciationResult {
  const words: ScoredWord[] = phonemes.flatMap((phoneme, i) =>
    [0, 1].map((n) => ({
      word: `w${i}-${n}`,
      accuracy: 40,
      errorType: "None",
      phonemes: [{ phoneme, accuracy: 40 }],
      syllables: [],
    })),
  );
  return {
    indeterminate: false,
    provider: "test",
    recognized: "x",
    overall: 40,
    accuracy: 40,
    fluency: 40,
    completeness: 40,
    words,
  };
}

function progressWith(result: PronunciationResult): ActivityProgress[] {
  const attempt: ActivityAttempt = {
    activityId: 1,
    result,
    accuracy: 40,
    at: "2026-09-07T10:00:00.000Z",
  };
  return [{ activityId: 1, attempts: [attempt, attempt], best: 40, passed: false, skipped: false }];
}

/**
 * Every string the four languages carry, with a label saying where it came
 * from: the set's own `code`, `slug` and `label`, and each activity's six
 * text fields.
 *
 * Written as one enumerator because the first draft walked activity fields
 * only, and a mutation putting an emoji in a language's `label` — which the
 * picker renders — went straight past it.
 */
function everyString(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const language of LANGUAGES) {
    for (const field of ["code", "slug", "label"] as const) {
      out.push([`${language.slug} ${field}`, language[field]]);
    }
    for (const activity of language.activities) {
      for (const [field, value] of Object.entries(activity)) {
        if (typeof value !== "string") continue;
        out.push([`${language.slug} activity ${activity.id} ${field}`, value]);
      }
    }
  }
  return out;
}

const ACTIVITY: Activity = {
  id: 1,
  title: "t",
  kind: "repeat",
  prompt: "p",
  gloss: "g",
  target: "x",
  focus: "f",
};

describe("all four languages are shipped and addressable", () => {
  it("ships exactly fr, es, de and hi, each with a locale and a slug", () => {
    expect(LANGUAGES.map((l) => l.slug)).toEqual(["fr", "es", "de", "hi"]);
    expect(LANGUAGES.map((l) => l.code)).toEqual(["fr-FR", "es-ES", "de-DE", "hi-IN"]);
    for (const language of LANGUAGES) {
      expect(getLanguage(language.slug)).toBe(language);
    }
  });

  it("gives every language a locale that is a usable BCP-47 tag", () => {
    /**
     * The same string is three things at once: Azure's assessment locale, the
     * `lang` attribute a screen reader reads a phrase with (WCAG 3.1.2), and
     * the key the report groups by. A malformed tag breaks the middle one
     * silently — a browser ignores an unparseable `lang` and reads the phrase
     * in the page language, which for a pronunciation product is the one
     * failure that matters.
     */
    for (const { code } of LANGUAGES) {
      expect(code, code).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
      // Round-trips through Intl, which is the actual BCP-47 parser the
      // platform will use.
      expect(new Intl.Locale(code).toString(), code).toBe(code);
      expect(new Intl.Locale(code).language, code).toBe(code.slice(0, 2));
      expect(new Intl.Locale(code).region, code).toBe(code.slice(3));
    }
  });
});

describe("each language is written in its own script", () => {
  it("keeps Hindi in Devanagari, with no transliteration anywhere", () => {
    /**
     * hi-IN's assessment expects Devanagari, and a transliterated target
     * ("namaste") would be scored as Latin text against a Devanagari model —
     * plausible numbers about the wrong thing. It is also the difference
     * between a learner reading their own language and reading a spelling of
     * it invented for English keyboards.
     */
    const hindi = getLanguage("hi");
    expect(hindi).toBeDefined();
    for (const activity of hindi?.activities ?? []) {
      const where = `hi activity ${activity.id}`;
      expect(activity.target, where).toMatch(/\p{Script=Devanagari}/u);
      // Not one Latin letter in a target. The gloss and prompt are English
      // instruction and are supposed to be Latin — only the target is scored.
      expect(activity.target, where).not.toMatch(/\p{Script=Latin}/u);
    }
  });

  it("keeps the other three in Latin, with no Devanagari leaking in", () => {
    for (const language of LANGUAGES.filter((l) => l.slug !== "hi")) {
      for (const activity of language.activities) {
        const where = `${language.slug} activity ${activity.id}`;
        expect(activity.target, where).toMatch(/\p{Script=Latin}/u);
        expect(activity.target, where).not.toMatch(/\p{Script=Devanagari}/u);
      }
    }
  });

  it("uses no character outside the script its font stack covers", () => {
    /**
     * The tofu guard. `--sans` is Nunito — Latin, Latin-Ext, Cyrillic and
     * Greek — then Noto Sans Devanagari, so a character in any *other* script
     * has no face behind it and renders as a box, and a box in the phrase a
     * learner is asked to say is indistinguishable from the app being broken.
     *
     * Greek is in the list because IPA borrows two of its letters outright:
     * θ (U+03B8) is the voiceless dental fricative and it is a *Greek*
     * code point, not a Latin one — es-ES activity 5's focus field says
     * "The Castilian θ in cercana", which is how this sweep found it. Nunito
     * covers Greek, so it is safe; the point of writing it down is that the
     * next script to appear here will not be.
     *
     * IPA Extensions (ʃ, ʁ, ɖ …) are Script=Latin and so already allowed. They
     * lean on Nunito's Latin-Ext subset, which this file cannot verify — the
     * font is fetched from Google Fonts, not bundled, so glyph coverage is not
     * inspectable from the repository. Worth knowing rather than asserting.
     *
     * An allow-list rather than a deny-list: a new language, or a character
     * pasted out of a word processor, has to be considered rather than merely
     * not having been thought of.
     */
    const allowed =
      /^[\p{Script=Latin}\p{Script=Devanagari}\p{Script=Greek}\p{Script=Common}\p{Script=Inherited}]+$/u;
    /**
     * `Script=Common` is broad enough to need a second gate: emoji live there
     * too, and a flag on the language picker has no glyph in Nunito either —
     * it renders as tofu, or as a font the rest of the page is not using. A
     * mutation putting 🇫🇷 in French's label passed the script check and was
     * caught only once this was added.
     */
    const pictographic = /\p{Extended_Pictographic}|\p{So}/u;

    let checked = 0;
    for (const [where, value] of everyString()) {
      expect(value, where).toMatch(allowed);
      expect(value, `${where} contains a symbol or emoji`).not.toMatch(pictographic);
      checked += 1;
    }
    // Four languages x (code, slug, label) plus ten activities x six string
    // fields each. Stated so a sweep that stopped visiting a field is visible.
    expect(checked).toBe(LANGUAGES.length * (3 + 10 * 6));
  });

  it("keeps each script inside the one language that uses it", () => {
    /**
     * Devanagari is a covered script, so the tofu check above rightly allows
     * it anywhere. It is still wrong anywhere but Hindi — a Devanagari
     * character in Spanish's label renders fine and means nothing, and it
     * would be tagged `lang="es-ES"` for a screen reader, which is worse than
     * tofu because it is silent.
     */
    for (const [where, value] of everyString()) {
      if (where.startsWith("hi ")) continue;
      expect(value, `${where} contains Devanagari`).not.toMatch(/\p{Script=Devanagari}/u);
    }
    // And the other way: Hindi's *targets* are Devanagari-only, while its
    // gloss and prompt are English instruction and so Latin by design.
    for (const [where, value] of everyString()) {
      if (!where.startsWith("hi ") || !where.endsWith(" target")) continue;
      expect(value, where).not.toMatch(/\p{Script=Latin}/u);
    }
  });

  it("stores every string already normalised", () => {
    /**
     * NFC, and it matters more than it looks: "é" as one code point and as
     * "e" plus a combining acute look identical and compare unequal. The
     * server's alignment strips combining marks deliberately
     * (server/alignment.ts), so a target in NFD and a recognition in NFC
     * would tokenise differently and the learner would be told they omitted a
     * word they said.
     */
    for (const [where, value] of everyString()) {
      expect(value.normalize("NFC"), where).toBe(value);
    }
  });

  it("never leaves a target empty or padded, in any script", () => {
    for (const language of LANGUAGES) {
      for (const activity of language.activities) {
        const where = `${language.slug} activity ${activity.id}`;
        expect(activity.target.trim(), where).toBe(activity.target);
        expect(activity.target.length, where).toBeGreaterThan(0);
        // No zero-width or bidi control characters, which are invisible in an
        // editor and change how a phrase is scored and shaped.
        // Written as escapes on purpose: a literal zero-width character in
        // this file would be as invisible here as in the content.
        expect(activity.target, where).not.toMatch(
          /[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/,
        );
      }
    }
  });
});

describe("IPA survives scoring", () => {
  it("is made of letters and marks, schwa included", () => {
    /**
     * The claim a test once got backwards. Every symbol here is `\p{L}` or a
     * sequence of `\p{L}` and `\p{M}` — which is exactly what the grapheme
     * validator on the sync path accepts, so a validator that rejected IPA
     * would be rejecting well-formed phonetic notation.
     */
    expect(/^\p{L}$/u.test("ə")).toBe(true); // ə is a letter. Not punctuation.
    expect(/^\p{Ll}$/u.test("ə")).toBe(true); // and specifically a lowercase one
    expect(/^\p{Lm}$/u.test("ː")).toBe(true); // ː is a modifier *letter*
    expect(/^\p{Mn}$/u.test("\u0303")).toBe(true); // the nasal tilde is a mark

    for (const symbol of IPA_SYMBOLS) {
      expect(symbol, symbol).toMatch(/^[\p{L}\p{M}]+$/u);
    }
  });

  it("keeps every symbol a distinct bucket through the report", () => {
    /**
     * The report groups phoneme scores by the symbol string. Two symbols that
     * compare equal — through normalisation, case folding, or a mark being
     * dropped — merge into one bucket, and the learner is then advised about
     * a sound that is the average of two different sounds.
     *
     * Run in chunks of four because `MAX_WEAK_PHONEMES` caps the list at six:
     * feeding all nineteen at once and asserting over what came back would
     * assert over a truncation. Every symbol gets an exact assertion this way.
     */
    let covered = 0;
    for (let start = 0; start < IPA_SYMBOLS.length; start += 4) {
      const chunk = IPA_SYMBOLS.slice(start, start + 4);
      const report = buildReport([ACTIVITY], progressWith(buildResult([...chunk])), 0);
      const returned = report.weakPhonemes.map((p) => p.phoneme);
      const where = `chunk from ${start}`;

      expect(report.phonemeLabelsAvailable, where).toBe(true);
      expect([...returned].sort(), where).toEqual([...chunk].sort());
      expect(new Set(returned).size, where).toBe(chunk.length);
      for (const entry of report.weakPhonemes) {
        expect(entry.occurrences, `${where}: ${entry.phoneme}`).toBe(2);
      }
      covered += chunk.length;
    }
    // Every symbol in the list was actually put through it.
    expect(covered).toBe(IPA_SYMBOLS.length);
  });

  it("does not merge a symbol with its own decomposition", () => {
    // ɔ̃ arrives as two code points. Its NFC form is the same two code points
    // — there is no precomposed nasal ɔ — so this is really a test that
    // nothing along the way *drops* the mark to get a "simpler" symbol.
    const composed = "\u0254\u0303"; // ɔ̃
    expect(composed.normalize("NFC")).toBe(composed);
    expect([...composed]).toHaveLength(2);

    const report = buildReport([ACTIVITY], progressWith(buildResult([composed, "ɔ"])), 0);
    const returned = report.weakPhonemes.map((p) => p.phoneme).sort();
    expect(returned).toEqual(["\u0254", "\u0254\u0303"]);
  });

  it("counts each symbol's occurrences and mean without touching the symbol", () => {
    // `buildResult` emits each symbol twice, so "ə" twice over is four
    // occurrences and "ʃ" once over is two. The progress carries the same
    // attempt twice and only the best one informs advice, so the count is one
    // attempt's worth — that is the property being pinned here.
    const report = buildReport([ACTIVITY], progressWith(buildResult(["ə", "ə", "ʃ"])), 0);
    expect(report.weakPhonemes.find((p) => p.phoneme === "ə")?.occurrences).toBe(4);
    expect(report.weakPhonemes.find((p) => p.phoneme === "ə")?.meanAccuracy).toBe(40);
    expect(report.weakPhonemes.find((p) => p.phoneme === "ʃ")?.occurrences).toBe(2);
  });

  it("drops an unlabelled phoneme rather than pooling it into a blank bucket", () => {
    /**
     * Every locale this product ships returns empty phoneme labels, so the
     * empty string is the *common* case rather than an edge one. Pooling them
     * would present one blank chip as a finding about the whole language.
     */
    const report = buildReport([ACTIVITY], progressWith(buildResult(["", "", "ə"])), 0);
    expect(report.weakPhonemes.map((p) => p.phoneme)).toEqual(["ə"]);
    expect(report.weakPhonemes.some((p) => p.phoneme === "")).toBe(false);
  });

  it("survives a JSON round trip byte-for-byte", () => {
    /**
     * Progress is persisted as JSON and restored across sessions, so a report
     * can be built from a result that has been through the encoder once
     * already. `JSON.stringify` escapes nothing above ASCII by default, and
     * `parse` composes nothing — asserted rather than assumed, because a
     * "helpful" replacer or a normalising serialiser would silently rewrite
     * every phoneme in the product.
     */
    const before = buildResult([...IPA_SYMBOLS]);
    const after = JSON.parse(JSON.stringify(before)) as PronunciationResult;
    expect(after).toEqual(before);

    if (!after.indeterminate) {
      // `buildResult` emits each symbol twice, so the expectation is the
      // doubled list rather than the list.
      const expected = IPA_SYMBOLS.flatMap((symbol) => [symbol, symbol]);
      const symbols = after.words.map((w) => w.phonemes[0]?.phoneme);
      expect(symbols).toEqual(expected);
      // Code point counts too, not just string equality: an expectation that
      // had itself been through the same normaliser would compare equal to a
      // renormalised value and prove nothing, so the lengths are checked
      // against the literals at the top of this file.
      for (const [i, symbol] of expected.entries()) {
        expect([...(symbols[i] ?? "")].length, symbol).toBe([...symbol].length);
      }
      expect([...(expected[32] ?? "")].length).toBe(2); // ɔ̃ is still two
      expect([...(expected[36] ?? "")].length).toBe(3); // t͡ʃ is still three
    }
  });

  it("keeps a Devanagari syllable grapheme intact through the report", () => {
    // The syllable path lower-cases graphemes to pool "Bon" with "bon".
    // Devanagari is caseless, so that must be a no-op — and a locale-aware
    // lower-casing would not be.
    // नमस्ते — "namaste", six code points including a virama and a vowel sign.
    const grapheme = "\u0928\u092e\u0938\u094d\u0924\u0947";
    expect(grapheme.toLowerCase()).toBe(grapheme);

    const result: PronunciationResult = {
      indeterminate: false,
      provider: "test",
      recognized: grapheme,
      overall: 40,
      accuracy: 40,
      fluency: 40,
      completeness: 40,
      words: [
        {
          word: grapheme,
          accuracy: 40,
          errorType: "None",
          phonemes: [],
          syllables: [
            { grapheme, accuracy: 30, offsetTicks: 0, durationTicks: 1 },
            { grapheme, accuracy: 50, offsetTicks: 2, durationTicks: 1 },
          ],
        },
      ],
    };
    const report = buildReport([ACTIVITY], progressWith(result), 0);
    expect(report.syllableLabelsAvailable).toBe(true);
    expect(report.weakSyllables.map((s) => s.grapheme)).toEqual([grapheme]);
    expect(report.weakSyllables[0]?.occurrences).toBe(2);
  });
});
