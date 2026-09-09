/**
 * T39 — Devanagari resolves to a real face, and no phrase overflows a phone.
 *
 * Both halves of this are invisible to the type system, to the test suite, and
 * to the machine the CSS was written on.
 *
 * **The font.** Nunito covers Latin, Latin-Ext, Cyrillic and Greek, and no
 * Devanagari. So every Hindi prompt fell past the brand font to whatever the
 * device happened to have: a different typeface on a good device, tofu boxes
 * on one without a Devanagari face at all. A quarter of the shipped languages
 * rendered unstyled and nobody noticed, because every machine this was written
 * on has a system Devanagari font. Nothing failed — that is the point.
 *
 * **The width.** `.phrase` is the product: 26px bold at the narrowest
 * viewport. A word longer than the line cannot be broken by the wrapper, so it
 * overflows horizontally and the phrase a learner is asked to say runs off the
 * side of the screen. German compounds are the risk and the check below is
 * arithmetic, because there is no layout engine here to ask.
 *
 * ## Why this file lives in scripts/
 *
 * It reads the stylesheet and `index.html` from disk. `src/` is typechecked by
 * tsconfig.json, which carries no Node types on purpose, so a test there
 * cannot `import "node:fs"`. tsconfig.scripts.json covers `scripts/**` and
 * does. vitest.config.ts includes `scripts/**\/*.test.ts` for this and for the
 * WAV header fuzz.
 *
 * ## What it cannot check, stated rather than implied
 *
 * The `unicode-range` subsetting that keeps a French learner from downloading
 * a 121 kB Devanagari face is in Google's `css2` response, not in this
 * repository — the tests below assert that both families are requested and
 * that Nunito is asked for first, which is what makes per-character fallback
 * keep Latin on Nunito. And jsdom does no layout and loads no fonts, so glyph
 * coverage cannot be verified from here at all; the width check is an explicit
 * model, with its assumptions written down.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LANGUAGES } from "../src/activities/languages/index.js";

const ROOT = join(import.meta.dirname, "..");

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

/** Every stylesheet, since the stylesheet is a directory. */
function sheets(): Array<{ name: string; text: string }> {
  const dir = join(ROOT, "src/styles");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".css"))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
}

/** The declared value of a custom property, from anywhere in the stylesheet. */
function customProperty(name: string): string {
  const all = sheets()
    .map((s) => s.text)
    .join("\n");
  // Multi-line values are normal here — `--sans` wraps.
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(all);
  const value = match?.[1];
  if (value === undefined) throw new Error(`--${name} is not declared in any sheet`);
  return value.replace(/\s+/g, " ").trim();
}

/** The families in a font stack, unquoted, in order. */
function families(stack: string): string[] {
  return stack
    .split(",")
    .map((f) => f.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

describe("the font stack reaches Devanagari without losing Latin", () => {
  it("declares --sans with Nunito first and a Devanagari face behind it", () => {
    /**
     * Order is the whole mechanism. CSS font matching is *per character*: a
     * Latin character finds a glyph in Nunito and stops there, and a
     * Devanagari character misses Nunito entirely and falls through to the
     * next family. Putting the Devanagari face first would work equally well
     * for Hindi and would silently restyle the other three languages.
     */
    const stack = families(customProperty("sans"));
    const nunito = stack.findIndex((f) => /^Nunito$/i.test(f));
    const devanagari = stack.findIndex((f) => /devanagari/i.test(f));

    expect(nunito, `--sans is ${stack.join(", ")}`).toBeGreaterThanOrEqual(0);
    expect(devanagari, `--sans has no Devanagari family: ${stack.join(", ")}`).toBeGreaterThanOrEqual(0);
    expect(nunito, "Nunito must come before the Devanagari face").toBeLessThan(devanagari);
    // And a generic at the end, so a device with neither webfont still has a
    // face rather than the browser's default serif.
    expect(stack[stack.length - 1]).toBe("sans-serif");
  });

  it("asks the font service for both families, with matching weights", () => {
    /**
     * The stack is a request the page has to honour. Naming
     * "Noto Sans Devanagari" in `--sans` without loading it leaves the same
     * bug in place with a comment claiming it is fixed — the family is not
     * installed on a phone, so the fallback still lands on whatever the
     * device has.
     */
    const html = read("index.html");
    const link = /<link[^>]*fonts\.googleapis\.com\/css2[^>]*>/.exec(html)?.[0] ?? "";
    expect(link, "index.html requests no Google Fonts stylesheet").toBeTruthy();

    expect(link).toContain("family=Nunito");
    expect(link).toContain("family=Noto+Sans+Devanagari");
    // Devanagari needs the weights the design actually uses — 700 for the
    // phrase, 400 for body — or a Hindi learner gets a synthesised bold.
    expect(link).toMatch(/family=Nunito:wght@\d+\.\.\d+/);
    expect(link).toMatch(/family=Noto\+Sans\+Devanagari:wght@\d+\.\.\d+/);
    // `swap`, so a slow font does not blank the phrase a learner is reading.
    expect(link).toContain("display=swap");
    // The two-hop DNS/TLS cost of a webfont, paid once up front.
    expect(html).toContain('rel="preconnect" href="https://fonts.gstatic.com"');
  });

  it("names every family in --sans in the font request, and nothing unrequested", () => {
    // The two webfonts are the only families that have to be fetched;
    // everything after them is a system font that is either present or not.
    const stack = families(customProperty("sans"));
    const html = read("index.html");
    const webfonts = stack.filter((f) => /^Nunito$|devanagari/i.test(f));
    expect(webfonts).toHaveLength(2);
    for (const family of webfonts) {
      expect(html, `${family} is in --sans but never requested`).toContain(
        `family=${family.replace(/ /g, "+")}`,
      );
    }
  });

  it("keeps --mono free of Devanagari, and keeps target text out of --mono", () => {
    /**
     * `--mono` is `ui-monospace, "SF Mono", Menlo, Consolas, monospace` and
     * covers no Devanagari — that is fine, because it is used for numbers,
     * labels and eyebrow text. It stops being fine the moment a rule that
     * holds target-language text is given it, and that would be a one-word
     * edit no type or test would otherwise catch.
     *
     * The classes below are the ones that render text in the language being
     * taught: the phrase, word chips, syllable chips and the "Heard:" line.
     */
    const mono = families(customProperty("mono"));
    expect(mono.some((f) => /devanagari|noto/i.test(f))).toBe(false);

    const carriesTargetLanguage = [".phrase", ".word", ".sy", ".hint"];
    for (const { name, text } of sheets()) {
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        if (!/font-family:\s*var\(--mono\)/.test(line)) return;
        // Walk back to the selector this declaration belongs to.
        let j = i;
        while (j >= 0 && !(lines[j] ?? "").includes("{")) j -= 1;
        const selector = (lines[j] ?? "").replace("{", "").trim();
        for (const target of carriesTargetLanguage) {
          // `.word small` is the score inside a chip, not the word — a
          // selector that *descends* into a chip is fine; one that IS the chip
          // is not.
          expect(
            selector.split(",").map((s) => s.trim()),
            `${name}:${i + 1} puts target-language text in --mono`,
          ).not.toContain(target);
        }
      });
    }
  });

  it("uses no hard-coded font stack anywhere, so the tokens cannot be bypassed", () => {
    // Every font-family in the stylesheet resolves through --sans or --mono.
    // A literal stack would be a second, unversioned answer to "which face
    // renders Devanagari".
    for (const { name, text } of sheets()) {
      text.split("\n").forEach((line, i) => {
        if (!/font-family\s*:/.test(line)) return;
        expect(line, `${name}:${i + 1}`).toMatch(/font-family:\s*var\(--(sans|mono)\)/);
      });
    }
  });
});

/**
 * ── the width model ─────────────────────────────────────────────────────────
 *
 * There is no layout engine in a unit test, so the check below is arithmetic
 * with its assumptions stated. Each one is deliberately pessimistic, so a
 * pass means "fits with room" rather than "fits if everything is average".
 */

/** The narrowest viewport in PRD §3 S2's platform list: an iPhone SE at 320px. */
const NARROWEST_VIEWPORT_PX = 320;

/** Characters materially narrower than the average in a rounded sans. */
const NARROW = new Set([..."iljtfrI'’.,;:!|()[]"]);
/** And materially wider. */
const WIDE = new Set([..."mwMW@"]);

/**
 * Upper bounds on advance width, in em, per character class.
 *
 * Nunito Bold measures about 0.55em for lowercase 'e', 0.27em for 'i' and
 * 0.87em for 'm'; the figures here sit above each of those. Devanagari base
 * letters in Noto Sans Devanagari run 0.6–0.75em, so 0.80 is the ceiling.
 * Non-spacing marks (Mn — viramas, most vowel signs) advance nothing;
 * spacing marks (Mc — U+093E AA, U+093F I, U+0940 II, U+094B O) do, and get
 * their own allowance.
 */
function advanceEm(ch: string): number {
  if (/\p{Mn}/u.test(ch)) return 0;
  if (/\p{Mc}/u.test(ch)) return 0.45;
  if (/\p{Script=Devanagari}/u.test(ch)) return 0.8;
  if (NARROW.has(ch)) return 0.4;
  if (WIDE.has(ch)) return 1;
  if (/\p{Lu}/u.test(ch)) return 0.75;
  return 0.65;
}

/**
 * Where a browser may break a line, per UAX #14, restricted to what appears
 * in this content: whitespace, and the hyphen family. Notably *not* the
 * apostrophe — "aujourd'hui" is one unbreakable run, not two.
 */
const BREAK_OPPORTUNITY =
  // \s already covers the no-break spaces. The rest is the hyphen family
  // (U+002D hyphen-minus, U+00AD soft hyphen, U+2010\u2013U+2015 dashes,
  // U+058A Armenian hyphen, U+2E17 double oblique) plus the solidus.
  /[\s\u002d\u00ad\u2010-\u2015\u058a\u2e17\u002f]/u;

/** The longest run of characters a browser cannot break, and its width. */
function longestUnbreakableRun(text: string): { run: string; em: number } {
  let worst = { run: "", em: 0 };
  for (const run of text.split(BREAK_OPPORTUNITY)) {
    if (!run) continue;
    const em = [...run].reduce((total, ch) => total + advanceEm(ch), 0);
    if (em > worst.em) worst = { run, em };
  }
  return worst;
}

/** `clamp(min, preferred, max)` on `font-size`, resolved for a viewport width. */
function phraseFontSizePx(viewportPx: number): number {
  const css = read("src/styles/activity.css");
  const rule = /\.phrase\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? "";
  const clamp = /font-size:\s*clamp\(\s*([\d.]+)px\s*,\s*([\d.]+)vw\s*,\s*([\d.]+)px\s*\)/.exec(rule);
  if (!clamp) throw new Error(`.phrase has no font-size clamp(): ${rule.trim().slice(0, 120)}`);
  const [min, vw, max] = [Number(clamp[1]), Number(clamp[2]), Number(clamp[3])];
  return Math.max(min, Math.min(max, (viewportPx * vw) / 100));
}

/** The page's horizontal gutters, from the `body` rule in base.css. */
function gutterPx(): number {
  const css = read("src/styles/base.css");
  const match = /padding-left:\s*max\(\s*(\d+)px/.exec(css);
  if (!match?.[1]) throw new Error("base.css declares no padding-left: max(Npx, ...)");
  return Number(match[1]);
}

describe("no language's phrases break at phone width", () => {
  it("reads the real font size and gutters out of the stylesheet", () => {
    // Stated so a CSS change moves the numbers below rather than leaving this
    // file asserting against a size the product no longer uses.
    expect(phraseFontSizePx(NARROWEST_VIEWPORT_PX)).toBe(26);
    expect(phraseFontSizePx(1200)).toBe(38);
    expect(phraseFontSizePx(500)).toBe(32.5);
    expect(gutterPx()).toBe(20);
  });

  it("fits the longest unbreakable run of every target in every language", () => {
    /**
     * The failure being checked: a wrapper can only break a line where the
     * text allows it, so a single word wider than the available line
     * overflows horizontally however the paragraph is styled. German is where
     * that lives — "siebenundvierzig" is sixteen characters in one run.
     */
    const fontPx = phraseFontSizePx(NARROWEST_VIEWPORT_PX);
    const availablePx = NARROWEST_VIEWPORT_PX - 2 * gutterPx();
    expect(availablePx).toBe(280);

    const worstByLanguage = new Map<string, { run: string; px: number }>();
    for (const language of LANGUAGES) {
      let worst = { run: "", px: 0 };
      for (const activity of language.activities) {
        const { run, em } = longestUnbreakableRun(activity.target);
        const px = em * fontPx;
        if (px > worst.px) worst = { run, px };
      }
      worstByLanguage.set(language.code, worst);
      expect(
        worst.px,
        `${language.code}: "${worst.run}" needs ${worst.px.toFixed(0)}px of ${availablePx}px`,
      ).toBeLessThanOrEqual(availablePx);
    }

    // All four measured, and the tightest is German — recorded so the margin
    // is visible rather than implied. Measured today: 244px of 280px, 13%
    // spare. That is the number to look at when adding a compound noun.
    expect([...worstByLanguage.keys()]).toEqual(["fr-FR", "es-ES", "de-DE", "hi-IN"]);
    const tightest = [...worstByLanguage.entries()].sort((a, b) => b[1].px - a[1].px)[0];
    expect(tightest?.[0]).toBe("de-DE");
    expect(tightest?.[1].px).toBeLessThan(availablePx);
    expect(tightest?.[1].px).toBeGreaterThan(availablePx * 0.7);
  });

  it("has a model that is pessimistic, so a pass means real headroom", () => {
    /**
     * The model is only worth having if it over-estimates. Checked against
     * Nunito Bold's actual advance widths — 'e' 0.55em, 'i' 0.27em,
     * 'm' 0.87em, 'M' 0.72em — every one of which is below the figure used.
     */
    expect(advanceEm("e")).toBeGreaterThan(0.55);
    expect(advanceEm("i")).toBeGreaterThan(0.27);
    expect(advanceEm("m")).toBeGreaterThan(0.87);
    expect(advanceEm("M")).toBeGreaterThan(0.72);
    // A non-spacing mark stacks above its base and advances nothing; a
    // spacing one does not.
    expect(advanceEm("\u094d")).toBe(0); // DEVANAGARI SIGN VIRAMA, category Mn
    expect(advanceEm("\u0940")).toBeGreaterThan(0); // VOWEL SIGN II, category Mc
    expect(advanceEm("\u0928")).toBe(0.8); // DEVANAGARI LETTER NA, a base consonant
  });

  it("would fail on a compound long enough to overflow", () => {
    /**
     * The negative control. A budget nothing can fail is not a budget, so the
     * model is shown rejecting the thing it exists to reject: at 26px in 280px
     * the ceiling is about seventeen average characters, and German produces
     * words far longer than that ("Geschwindigkeitsbegrenzung" is 26).
     */
    const fontPx = phraseFontSizePx(NARROWEST_VIEWPORT_PX);
    const availablePx = NARROWEST_VIEWPORT_PX - 2 * gutterPx();

    expect(longestUnbreakableRun("Geschwindigkeitsbegrenzung").em * fontPx).toBeGreaterThan(
      availablePx,
    );
    // And it is not merely rejecting everything long: a hyphenated compound of
    // the same length breaks at the hyphen and fits.
    expect(longestUnbreakableRun("Geschwindigkeits-begrenzung").em * fontPx).toBeLessThanOrEqual(
      availablePx,
    );
    // The boundary, so the ceiling is a number rather than a feeling.
    expect(longestUnbreakableRun("e".repeat(16)).em * fontPx).toBeLessThanOrEqual(availablePx);
    expect(longestUnbreakableRun("e".repeat(17)).em * fontPx).toBeGreaterThan(availablePx);
  });

  it("does not stop the phrase wrapping at all", () => {
    /**
     * `white-space: nowrap` on the phrase would turn every multi-word target
     * into one unbreakable run, which no length ceiling on a single word would
     * catch. The rule is checked rather than assumed because it is three words
     * and lives in the same block.
     */
    const css = read("src/styles/activity.css");
    const rule = /\.phrase\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? "";
    expect(rule).toBeTruthy();
    expect(rule).not.toMatch(/white-space:\s*nowrap/);
    expect(rule).not.toMatch(/white-space:\s*pre(?![-\w])/);
    // `text-wrap: balance` is fine — it changes where lines break, not
    // whether they do.
    expect(rule).toMatch(/text-wrap:\s*balance/);
  });

  it("is protected either by a break fallback or by content that fits", () => {
    /**
     * The property stated as the disjunction it really is, so that fixing it
     * does not break the test that found it.
     *
     * A phrase cannot overflow horizontally if *either* the CSS lets the
     * wrapper break inside a word (`overflow-wrap`, `word-break` or
     * `hyphens`), *or* no word in any target is wider than the line. Today
     * only the second holds: `.phrase` sets none of the three, and the
     * shipped content fits with 13% spare in the tightest case (German).
     *
     * That makes the length ceiling above load-bearing rather than a
     * belt-and-braces check — the next compound noun someone adds is the only
     * thing between this and a phrase running off the side of a phone. One
     * line of CSS would make the overflow impossible instead of merely
     * absent, and would cost nothing on phrases that already fit.
     * src/styles/ is not this change's to edit, so it is written down here
     * and reported rather than fixed.
     *
     * Either way round, this test passes — and it fails if both protections
     * are ever gone at once, which is the thing that must not happen.
     */
    const css = read("src/styles/activity.css");
    const rule = /\.phrase\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? "";
    const hasBreakFallback = /overflow-wrap|word-break|hyphens/.test(rule);

    const fontPx = phraseFontSizePx(NARROWEST_VIEWPORT_PX);
    const availablePx = NARROWEST_VIEWPORT_PX - 2 * gutterPx();
    const everyTargetFits = LANGUAGES.every((language) =>
      language.activities.every(
        (activity) => longestUnbreakableRun(activity.target).em * fontPx <= availablePx,
      ),
    );

    expect(
      hasBreakFallback || everyTargetFits,
      "the phrase can neither break inside a word nor fit one — it will overflow",
    ).toBe(true);

    // The fitting half is asserted on its own above, and must keep holding
    // while it is the only protection there is. Deliberately *not* asserting
    // which of the two is currently true: a test that fails when someone adds
    // the missing CSS line is a test that punishes the fix.
    expect(everyTargetFits).toBe(true);
  });
});
