/**
 * The two tap floors, and the relationship between them.
 *
 * The design constraints name two numbers — "44px minimum target, 48px
 * thumb-driven" — and for a long time one token carried both jobs. `--tap` was
 * 44 and every button used it, while every button on every design board is
 * drawn at 48. That looked like a contradiction between the board and
 * `verify.mjs` and was not: a *floor for everything* and a *size for the
 * controls a thumb drives* are different numbers, and 44 was answering as
 * both.
 *
 * `scripts/verify.mjs` enforces the floor — no declared target below 44
 * anywhere. This file holds the part a floor cannot express: that the thumb
 * size is at least the floor, and that the controls a learner actually drives
 * use it.
 */

import { describe, expect, test } from "vitest";

const sheets = import.meta.glob("./**/*.css", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function px(token: string): number {
  const tokens = sheets["./tokens.css"] ?? "";
  const match = new RegExp(`${token}:\\s*(\\d+(?:\\.\\d+)?)px`).exec(tokens);
  return match?.[1] === undefined ? Number.NaN : Number(match[1]);
}

/** The block a selector opens, up to its closing brace. */
function block(sheet: string, selector: string): string {
  const source = sheets[`./${sheet}`] ?? "";
  const at = source.indexOf(`${selector} {`);
  if (at === -1) return "";
  return source.slice(at, source.indexOf("}", at));
}

describe("the two floors", () => {
  test("both are declared in px, so a rule can read them", () => {
    expect(px("--tap")).toBe(44);
    expect(px("--tap-thumb")).toBe(48);
  });

  /**
   * The relationship, and the reason this file exists rather than two
   * literals. A thumb size below the floor would shrink the controls a learner
   * uses most while every other target stayed compliant — and `verify.mjs`
   * would pass, because 44 is the only number it knows.
   */
  test("the thumb size is at least the floor", () => {
    expect(px("--tap-thumb")).toBeGreaterThanOrEqual(px("--tap"));
  });

  test("the floor is still the 44 the constraints ask for", () => {
    // Lowering `--tap` is the one change that silently relaxes every target in
    // the product, and `verify.mjs` reads this same token to do its work — so
    // it cannot catch the token itself moving.
    expect(px("--tap")).toBeGreaterThanOrEqual(44);
  });
});

describe("what the thumb size is for", () => {
  /**
   * A button is the control a learner drives — record, advance, commit — and
   * every board draws it at 48.
   */
  test("a button is sized for a thumb, not to the floor", () => {
    expect(block("base.css", "button")).toContain("min-height: var(--tap-thumb)");
  });

  /**
   * Three anchors exist only to restate the button rule, because an `<a>` does
   * not inherit it. They have to follow it, or a link that looks exactly like
   * a button is four pixels shorter than one.
   */
  test("every anchor that restates the button rule follows it", () => {
    for (const [sheet, selector] of [
      ["base.css", "a.enter-cta"],
      ["base.css", "a.ghost"],
      ["authoring.css", "a.authoring-preview"],
    ] as const) {
      const rule = block(sheet, selector);
      expect(rule, `${sheet} has no ${selector} block`).not.toBe("");
      expect(rule, `${selector} should follow button`).toContain("min-height: var(--tap-thumb)");
    }
  });

  /**
   * The controls a thumb drives, named.
   *
   * `button.sy` is the syllable chip, and NFR-03's own comment calls it "the
   * product's core interaction" — tapping one plays back that slice of the
   * learner's own audio. It shipped at 36px once, which is the reason the rule
   * exists at all. Nothing pinned it to the thumb size until a mutation moved
   * it back to the floor and every test stayed green.
   */
  test("the controls a learner drives are all sized for a thumb", () => {
    for (const [sheet, selector] of [
      ["components/chip.css", "button.sy"],
      ["components/control.css", ".modes button"],
    ] as const) {
      const rule = block(sheet, selector);
      expect(rule, `${sheet} has no ${selector} block`).not.toBe("");
      expect(rule, `${selector} is thumb-driven`).toContain("min-height: var(--tap-thumb)");
    }
  });

  /**
   * And the floor still applies to everything else. Breadcrumbs, disclosures
   * and the language select are reached rather than driven, and sizing them
   * all at 48 would push the top of every screen down for no gain.
   */
  test("targets that are reached rather than driven keep the floor", () => {
    expect(block("base.css", ".breadcrumb a")).toContain("min-height: var(--tap)");
    expect(block("components/disclosure.css", "summary")).toContain("min-height: var(--tap)");
  });
});

describe("nothing uses a literal where a token exists", () => {
  /**
   * The rule that keeps both numbers meaningful. A `min-height: 48px` written
   * out is a target that stops moving when the token does — and reads as
   * compliant to anybody grepping for the token.
   */
  test("no declared tap target is a bare pixel literal", () => {
    const offences: string[] = [];

    for (const [path, source] of Object.entries(sheets)) {
      const lines = source.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        const match = /^\s*min-(?:height|width):\s*(\d+)px/.exec(line);
        if (match === null) continue;
        const value = Number(match[1]);
        // 44 and 48 are the two that must come from a token. Anything else is
        // a deliberate size for something that is not a tap target.
        if (value === 44 || value === 48) offences.push(`${path}:${i + 1} ${line.trim()}`);
      }
    }

    expect(offences, offences.join("\n")).toEqual([]);
  });
});
