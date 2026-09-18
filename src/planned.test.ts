/**
 * The rules a "coming soon" has to keep to stay honest.
 *
 * This product refuses to show a score it did not measure, a count it cannot
 * check, or a figure about a child it has no right to. A roadmap on a screen
 * is the same kind of claim pointed at the future, and the ways it goes wrong
 * are predictable enough to check.
 */

import { describe, expect, it } from "vitest";
import { PLANNED } from "./planned.js";

describe("nothing here carries a date", () => {
  /**
   * The rule that matters most, and the reason the list exists in this shape.
   *
   * A date is the part of a promise that can break while the feature is still
   * being built honestly. It buys nothing a learner needs — they are deciding
   * whether to wait, not when to diarise — and it costs the trust the rest of
   * the product spends so much care accumulating.
   */
  it("names no month, quarter, year or season", () => {
    const forbidden =
      /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\bQ[1-4]\b|\b20\d\d\b|\b(spring|summer|autumn|winter)\b|\bnext (week|month|year|release|version)\b/i;

    for (const feature of PLANNED) {
      const text = `${feature.title} ${feature.because}`;
      expect(forbidden.test(text), `"${feature.title}" carries a date`).toBe(false);
    }
  });

  /**
   * "Soon" is a date wearing a disguise. It sets an expectation precisely
   * because it sounds like it does not.
   */
  it("does not say soon, shortly, or imminently", () => {
    for (const feature of PLANNED) {
      const text = `${feature.title} ${feature.because}`.toLowerCase();
      for (const word of ["soon", "shortly", "imminent", "any day", "just around"]) {
        expect(text.includes(word), `"${feature.title}" says "${word}"`).toBe(false);
      }
    }
  });
});

describe("every entry says what it is for and why it is late", () => {
  it("has a reason, not a placeholder", () => {
    for (const feature of PLANNED) {
      // Long enough to be a sentence. A one-word reason is a shrug.
      expect(feature.because.length, `"${feature.title}" has no real reason`).toBeGreaterThan(40);
      expect(feature.title.length).toBeGreaterThan(3);
    }
  });

  /**
   * Written for the person reading it. "Expand the language catalogue" is what
   * we would do; "German and Hindi" is what they would get, and only the
   * second helps somebody decide whether to wait.
   */
  it("describes the outcome rather than the work", () => {
    for (const feature of PLANNED) {
      const title = feature.title.toLowerCase();
      for (const word of ["refactor", "migrate", "implement", "build out", "rewrite", "api", "backend"]) {
        expect(title.includes(word), `"${feature.title}" is written from our side`).toBe(false);
      }
    }
  });

  it("says each thing once", () => {
    expect(new Set(PLANNED.map((f) => f.title)).size).toBe(PLANNED.length);
  });
});

describe("the list stays short", () => {
  /**
   * A long list of things that do not exist reads as a product that does
   * less than it says. Five is generous; past that, the honest move is to
   * ship something rather than announce another.
   */
  it("holds at most five entries", () => {
    expect(PLANNED.length).toBeLessThanOrEqual(5);
  });

  it("has something to say, or the screen would render an empty promise", () => {
    // An empty list renders nothing at all, which is correct — this asserts
    // the file is not accidentally empty while the component still ships.
    expect(PLANNED.length).toBeGreaterThan(0);
  });
});
