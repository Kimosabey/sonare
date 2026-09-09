// @vitest-environment jsdom

/**
 * T39 — every string in a target language carries `lang`, in all four of them.
 *
 * WCAG 3.1.2, Language of Parts. Without `lang` a screen reader pronounces
 * French with English phonetics and Devanagari not at all — in a product whose
 * entire purpose is pronunciation, which makes it the one place a synthetic
 * voice must get a phrase right. The components already document the policy;
 * this file holds them to it, and holds them to the *other* half of it too:
 * the prompt, gloss and focus are English instruction *about* the phrase, and
 * tagging those would make a reader speak English in a French voice, which is
 * worse than leaving them untagged.
 *
 * Existing component tests each check one component at one locale. What was
 * missing is the sweep: all four shipped locales through every component that
 * renders target-language text, so a component that happens to be right for
 * fr-FR and wrong for hi-IN cannot pass.
 *
 * It also carries the storage half of the IPA question. That cannot live in
 * src/activities/ (a DOM-free zone, so no browser storage) or under
 * src/speech/ (verify.mjs R11 forbids naming browser storage anywhere in that
 * tree), so it lives here — at the root, beside App.test.tsx.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LANGUAGES } from "./activities/languages/index.js";
import { ScoreCard } from "./speech/components/ScoreCard.js";
import { SyllableChips } from "./speech/components/SyllableChips.js";
import { WordChips } from "./speech/components/WordChips.js";
import type { PronunciationResult, ScoredSyllable, ScoredWord } from "./speech/scoring/types.js";

// No `globals: true` in vitest.config.ts, so Testing Library never registers
// its auto-cleanup and renders would accumulate in one jsdom document.
afterEach(cleanup);

/**
 * jsdom has no `matchMedia`, and ScoreCard's animated cells ask it about
 * reduced motion on mount. Same stub as ScoreCard.test.tsx: "no preference",
 * so the scored branch renders its ordinary path rather than the shortcut —
 * which is the path that actually contains the text this file is about.
 */
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
});

/**
 * A word, a syllable and a whole phrase per language, taken from that
 * language's own first activity target so the text is genuinely in the script
 * under test rather than a Latin stand-in with a `lang` attribute on it.
 *
 * `phrase` is deliberately a *different string* from `word`. It is used as the
 * recognised text on the score card, which renders the two in different
 * places — and when they were the same string, a card that stopped tagging
 * the recognised text still passed, because the word chip's own tag carried
 * an identical string. A mutation found that; this is the fix.
 */
function sampleFor(code: string): { word: string; syllable: string; phrase: string } {
  const language = LANGUAGES.find((l) => l.code === code);
  const target = language?.activities[0]?.target ?? "";
  const first = target.split(/\s+/u)[0]?.replace(/[.,!?;:]+$/u, "") ?? "";
  // A syllable is a slice of the word — half of it, by code points, so a
  // combining mark cannot be split off from its base.
  const points = [...first];
  return {
    word: first,
    syllable: points.slice(0, Math.max(1, Math.ceil(points.length / 2))).join(""),
    phrase: target,
  };
}

function wordsFor(code: string): ScoredWord[] {
  const { word, syllable } = sampleFor(code);
  return [
    {
      word,
      accuracy: 72,
      errorType: "None",
      phonemes: [{ phoneme: "\u0259", accuracy: 60 }], // ə (schwa)
      syllables: [{ grapheme: syllable, accuracy: 72, offsetTicks: 0, durationTicks: 1_000_000 }],
    },
  ];
}

function resultFor(code: string): PronunciationResult {
  const { phrase } = sampleFor(code);
  return {
    indeterminate: false,
    provider: "test",
    recognized: phrase,
    overall: 72,
    accuracy: 72,
    fluency: 70,
    completeness: 80,
    words: wordsFor(code),
  };
}

/** Text inside an element carrying `lang="<code>"`, deduplicated. */
function taggedText(container: HTMLElement, code: string): Set<string> {
  return new Set(
    [...container.querySelectorAll(`[lang="${code}"]`)]
      .map((e) => e.textContent ?? "")
      .filter(Boolean),
  );
}

/** Every element carrying any `lang` attribute at all. */
function allLangValues(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[lang]")].map((e) => e.getAttribute("lang") ?? "");
}

describe("every target-language string is tagged, in all four languages", () => {
  it("has a distinct sample word for each language, and Devanagari for Hindi", () => {
    // The fixtures have to be real, or the sweep below tags Latin text four
    // times and proves nothing about Devanagari.
    const samples = LANGUAGES.map((l) => sampleFor(l.code));
    expect(new Set(samples.map((s) => s.word)).size).toBe(LANGUAGES.length);
    expect(new Set(samples.map((s) => s.phrase)).size).toBe(LANGUAGES.length);
    for (const sample of samples) {
      expect(sample.word.length).toBeGreaterThan(0);
      // The phrase must differ from the word, or the score card assertions
      // below cannot tell the two tagged elements apart.
      expect(sample.phrase, sample.word).not.toBe(sample.word);
      expect(sample.phrase).toContain(sample.word);
    }
    expect(sampleFor("hi-IN").word).toMatch(/\p{Script=Devanagari}/u);
    expect(sampleFor("hi-IN").word).not.toMatch(/\p{Script=Latin}/u);
    for (const code of ["fr-FR", "es-ES", "de-DE"]) {
      expect(sampleFor(code).word, code).toMatch(/\p{Script=Latin}/u);
    }
  });

  it("tags the word chips with the language being taught", () => {
    for (const { code } of LANGUAGES) {
      const { word } = sampleFor(code);
      const { container } = render(<WordChips words={wordsFor(code)} lang={code} />);
      expect(taggedText(container, code), code).toContain(word);
      // Every `lang` on the page is the language being taught — no stray tag
      // pointing a reader at the wrong voice.
      expect(new Set(allLangValues(container)), code).toEqual(new Set([code]));
      cleanup();
    }
  });

  it("tags the syllable chips, visible label and screen-reader label alike", () => {
    for (const { code } of LANGUAGES) {
      const { syllable } = sampleFor(code);
      const syllables: ScoredSyllable[] = [
        { grapheme: syllable, accuracy: 72, offsetTicks: 0, durationTicks: 1_000_000 },
      ];
      const { container } = render(<SyllableChips syllables={syllables} lang={code} />);
      const tagged = [...container.querySelectorAll(`[lang="${code}"]`)];

      // Two: the glyphs a sighted learner reads and the name a screen reader
      // speaks. Browsers pick fonts and shaping from `lang` too, which is what
      // makes it matter on the visible one.
      expect(tagged.length, code).toBe(2);
      for (const element of tagged) expect(element.textContent, code).toBe(syllable);
      cleanup();
    }
  });

  it("tags the recognised text on the score card, and the word chip too", () => {
    /**
     * Both, separately. The card renders the phrase Azure heard *and* a chip
     * per word, and they are different strings here on purpose: an assertion
     * that only asked "is this language's text tagged somewhere" passed with
     * the recognised text untagged, because the chip's tag carried a matching
     * substring.
     */
    for (const { code } of LANGUAGES) {
      const { word, phrase } = sampleFor(code);
      const { container } = render(<ScoreCard result={resultFor(code)} lang={code} />);
      const tagged = taggedText(container, code);

      expect(tagged, `${code} recognised text`).toContain(phrase);
      expect(tagged, `${code} word chip`).toContain(word);
      expect(new Set(allLangValues(container)), code).toEqual(new Set([code]));
      cleanup();
    }
  });

  it("leaves the English instruction untagged, including the line that wraps a tag", () => {
    /**
     * The other half of the policy, and the easier one to get wrong by being
     * thorough: `lang` on the whole card would tell a reader that "Accuracy is
     * the one that counts toward passing" is French.
     *
     * Two assertions, because the first draft had only the ASCII one and a
     * mutation walked straight past it. The "Heard: “…”" paragraph contains
     * the target phrase and curly quotes, so it is *not* ASCII and was
     * filtered out of the check — which is exactly the paragraph where the
     * mistake is most natural to make, since it is the one that already has a
     * `lang` somewhere inside it. So: every element that carries `lang` must
     * be a leaf whose whole text is target-language, never a wrapper around
     * English.
     */
    for (const { code } of LANGUAGES) {
      const { word, phrase } = sampleFor(code);
      const { container } = render(<ScoreCard result={resultFor(code)} lang={code} />);

      const english = [...container.querySelectorAll("p.hint, h2, h3, label")].filter((e) =>
        /^[\x20-\x7e]+$/.test(e.textContent ?? ""),
      );
      expect(english.length, code).toBeGreaterThan(0);
      for (const element of english) {
        expect(element.getAttribute("lang"), `${code}: ${element.textContent ?? ""}`).toBeNull();
      }

      // Nothing tagged may contain English. The tagged elements are exactly
      // the target-language strings and nothing more.
      const tagged = [...container.querySelectorAll("[lang]")];
      expect(tagged.length, code).toBeGreaterThan(0);
      for (const element of tagged) {
        const text = element.textContent ?? "";
        expect([phrase, word], `${code}: tagged element reads "${text}"`).toContain(text);
        // And it wraps nothing else — no English sibling text swept in.
        expect(element.querySelectorAll("[lang]").length, code).toBe(0);
      }
      cleanup();
    }
  });

  it("does not tag a syllable it could not name", () => {
    /**
     * hi-IN returns 0 graphemes out of 108 while scoring every syllable, so
     * for a whole language the label is a position — "2nd" — which is English
     * and must not be marked as Hindi. This is the case that makes the
     * conditional `lang` on SyllableChips load-bearing rather than tidy.
     */
    const unnamed: ScoredSyllable[] = [
      { grapheme: "", accuracy: 60, offsetTicks: 0, durationTicks: 1 },
      { grapheme: "", accuracy: 80, offsetTicks: 2, durationTicks: 1 },
    ];
    const { container } = render(<SyllableChips syllables={unnamed} lang="hi-IN" />);
    expect(container.querySelectorAll('[lang="hi-IN"]')).toHaveLength(0);
    expect(container.querySelectorAll("[lang]")).toHaveLength(0);
  });

  it("renders Devanagari as its own characters, not as escapes or boxes", () => {
    /**
     * The tofu question, as far as jsdom can answer it: jsdom does no layout
     * and loads no fonts, so it cannot tell whether a glyph exists — that half
     * is checked structurally in scripts/i18n-typography.test.ts. What it
     * *can* prove is that the text reaching the DOM is the Devanagari that
     * went in, code point for code point, rather than escapes, entities,
     * replacement characters or a mark that got separated from its base.
     */
    const { word } = sampleFor("hi-IN");
    const { container } = render(<WordChips words={wordsFor("hi-IN")} lang="hi-IN" />);
    const rendered = [...taggedText(container, "hi-IN")].find((t) => t === word) ?? "";

    expect(rendered).toBe(word);
    expect([...rendered].length).toBe([...word].length);
    expect(rendered).not.toContain("\ufffd"); // U+FFFD replacement character
    expect(rendered).not.toContain("&#");
    expect(rendered).not.toMatch(/\\u[0-9a-f]{4}/i);
    // A combining mark must still follow a base character, never lead.
    expect(rendered).not.toMatch(/^\p{M}/u);
  });
});

describe("IPA survives browser storage", () => {
  /**
   * A real in-memory Storage, installed over jsdom's.
   *
   * jsdom's `localStorage` here is a bare object with no methods, so a store
   * that calls `getItem` throws and every read returns its empty fallback —
   * which would make a storage test pass while storing nothing.
   */
  function installStorage(): Map<string, string> {
    const data = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, String(v)),
        removeItem: (k: string) => void data.delete(k),
        clear: () => data.clear(),
        key: (i: number) => [...data.keys()][i] ?? null,
        get length() {
          return data.size;
        },
      },
    });
    return data;
  }

  beforeEach(() => {
    installStorage();
  });

  const SYMBOLS = [
    "\u0259", // ə
    "\u0283", // ʃ
    "\u02d0", // ː
    "\u0254\u0303", // ɔ̃ — two code points
    "t\u0361\u0283", // t͡ʃ — three
    "\u0928\u092e\u0938\u094d\u0924\u0947", // नमस्ते
  ];

  it("comes back from storage code point for code point", () => {
    /**
     * Progress is persisted as JSON and restored across sessions, so every
     * phoneme symbol and every syllable grapheme makes this round trip. A
     * Storage that normalised — or a JSON encoder that escaped and a decoder
     * that composed — would silently rewrite the identity the report groups
     * by, merging two sounds into one.
     */
    for (const symbol of SYMBOLS) {
      window.localStorage.setItem("sonare.test", JSON.stringify({ symbol }));
      const raw = window.localStorage.getItem("sonare.test");
      expect(raw, symbol).not.toBeNull();
      const back = JSON.parse(raw ?? "{}") as { symbol: string };

      expect(back.symbol, symbol).toBe(symbol);
      expect([...back.symbol].length, symbol).toBe([...symbol].length);
      // Neither composed nor decomposed on the way through: the code point
      // count above already pins that, and this pins that the *sequence* is
      // the same one rather than a different sequence of the same length.
      expect([...back.symbol].map((c) => c.codePointAt(0)), symbol).toEqual(
        [...symbol].map((c) => c.codePointAt(0)),
      );
    }
  });

  it("keeps a whole scored result intact through storage", () => {
    const before = resultFor("hi-IN");
    window.localStorage.setItem("sonare.result", JSON.stringify(before));
    const after = JSON.parse(window.localStorage.getItem("sonare.result") ?? "null") as
      | PronunciationResult
      | null;

    expect(after).toEqual(before);
    if (after && !after.indeterminate && !before.indeterminate) {
      expect(after.recognized).toBe(before.recognized);
      expect([...after.recognized].length).toBe([...before.recognized].length);
      expect(after.words[0]?.phonemes[0]?.phoneme).toBe("\u0259");
      expect(after.words[0]?.syllables[0]?.grapheme).toBe(before.words[0]?.syllables[0]?.grapheme);
    }
  });

  it("renders identically before and after the round trip", () => {
    // The end of the chain: what a learner sees after reopening a saved
    // session is what they saw before closing it.
    const before = resultFor("hi-IN");
    const first = render(<ScoreCard result={before} lang="hi-IN" />);
    const beforeHtml = first.container.innerHTML;
    cleanup();

    window.localStorage.setItem("sonare.result", JSON.stringify(before));
    const restored = JSON.parse(
      window.localStorage.getItem("sonare.result") ?? "null",
    ) as PronunciationResult;
    const second = render(<ScoreCard result={restored} lang="hi-IN" />);

    expect(second.container.innerHTML).toBe(beforeHtml);
  });
});
