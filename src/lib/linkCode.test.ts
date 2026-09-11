/**
 * The link-code format, from the typing side.
 *
 * A link code is a bearer credential: it grants full read, write and delete of
 * one learner's record for ten minutes. So the interesting cases here are not
 * the happy ones — they are every way a string that is *not* a code could be
 * turned into one by being helpful.
 */

import { describe, expect, it } from "vitest";
import {
  LINK_CODE_ALPHABET,
  LINK_CODE_LENGTH,
  formatLinkCode,
  normaliseLinkCode,
} from "./linkCode.js";

/** A code built from the real alphabet, so the tests cannot drift from it. */
const VALID = LINK_CODE_ALPHABET.slice(0, LINK_CODE_LENGTH);

describe("normaliseLinkCode", () => {
  it("accepts a code as it is shown, grouped", () => {
    expect(normaliseLinkCode(formatLinkCode(VALID))).toBe(VALID);
  });

  it("accepts it ungrouped, so a learner who omits the hyphen is not punished", () => {
    expect(normaliseLinkCode(VALID)).toBe(VALID);
  });

  it("folds case, because nobody types a code in the case it was shown in", () => {
    expect(normaliseLinkCode(VALID.toLowerCase())).toBe(VALID);
  });

  it("strips the spaces a paste brings with it", () => {
    expect(normaliseLinkCode(`  ${VALID.slice(0, 5)} ${VALID.slice(5)}  `)).toBe(VALID);
  });

  /**
   * The one that matters most.
   *
   * Stripping *unknown* characters rather than only separators would let a
   * learner's typo — or an attacker's probe — normalise into a valid code. The
   * strip is `[\s-]` on purpose, and everything else is a refusal.
   */
  it("refuses unknown characters rather than stripping them into a valid code", () => {
    const interleaved = VALID.split("").join("!");
    expect(interleaved).toContain("!");
    expect(normaliseLinkCode(interleaved)).toBeNull();
  });

  it("refuses the characters the alphabet deliberately omits", () => {
    // 0/O, 1/I/L and U/V are all absent — both halves of each pair, so a
    // misread gives a wrong character rather than a wrong learner.
    for (const confusable of ["0", "O", "1", "I", "L", "U"]) {
      expect(LINK_CODE_ALPHABET).not.toContain(confusable);
      const withConfusable = confusable + VALID.slice(1);
      expect(normaliseLinkCode(withConfusable)).toBeNull();
    }
  });

  it("refuses anything of the wrong length", () => {
    expect(normaliseLinkCode(VALID.slice(0, -1))).toBeNull();
    expect(normaliseLinkCode(VALID + VALID[0])).toBeNull();
    expect(normaliseLinkCode("")).toBeNull();
  });

  it("refuses a non-string without reaching the loop", () => {
    for (const value of [null, undefined, 42, {}, [], true]) {
      expect(normaliseLinkCode(value)).toBeNull();
    }
  });

  it("refuses an absurdly long input before doing any work on it", () => {
    // A 64-character ceiling, so a megabyte of separators cannot be handed to
    // the replace above. The length check is deliberately first.
    expect(normaliseLinkCode("-".repeat(100_000) + VALID)).toBeNull();
  });
});

describe("formatLinkCode", () => {
  it("groups a code the way the screen shows it", () => {
    const shown = formatLinkCode(VALID);
    expect(shown).toBe(`${VALID.slice(0, 5)}-${VALID.slice(5)}`);
  });

  it("is the exact inverse of the strip, so what is shown can be typed back", () => {
    expect(normaliseLinkCode(formatLinkCode(VALID))).toBe(VALID);
  });

  it("does not regroup a code that already carries its grouping", () => {
    // Regrouping around its own hyphen would produce `ABCDE-FGHJ-K`, which is
    // a code-shaped thing no device can claim.
    const once = formatLinkCode(VALID);
    expect(formatLinkCode(once)).toBe(once);
  });

  it("returns something that is not a code untouched, rather than inventing a grouping", () => {
    // Putting a plausible-looking group on an unrecognised string would send a
    // learner off to type a credential that cannot exist.
    for (const notACode of ["hello", "", "0000000000", VALID.slice(0, 4)]) {
      expect(formatLinkCode(notACode)).toBe(notACode);
    }
  });
});
