/**
 * Eleven lines, and it decides what colour every score in the product is.
 *
 * Two reasons it is worth testing anyway. The thresholds are a shared
 * definition precisely so word chips and phoneme detail cannot drift apart,
 * which is a claim about both call sites, not about the arithmetic. And the
 * return values are CSS class names — a rename here does not break a type or
 * fail a build, it ships a page where every score renders in the default ink
 * and the banding silently stops existing. That exact mistake happened on this
 * project once already, with a function returning hi/mid/lo and a stylesheet
 * keyed on pass/warn/fail.
 *
 * The stylesheet half of that is enforced in scripts/verify.mjs rather than
 * here: Vitest short-circuits .css modules before Vite's ?raw query is
 * honoured, and it is a static cross-file invariant, which is what verify
 * exists for.
 */

import { describe, expect, it } from "vitest";
import { band } from "./band.js";

describe("band — T12 thresholds", () => {
  it("puts each boundary on the side T12 specifies", () => {
    // Off-by-one at a boundary is the whole risk surface here: 80 is a pass
    // and 79 is not, and a learner reading 80 against a stated bar of 80 must
    // not be told they missed it.
    expect(band(80)).toBe("hi");
    expect(band(79)).toBe("mid");
    expect(band(60)).toBe("mid");
    expect(band(59)).toBe("lo");
  });

  it("covers the whole 0-100 range with no gap", () => {
    for (let score = 0; score <= 100; score++) {
      expect(["hi", "mid", "lo"], String(score)).toContain(band(score));
    }
  });

  it("is monotonic, so a better score never bands worse", () => {
    const rank = { lo: 0, mid: 1, hi: 2 } as const;
    let previous = 0;
    for (let score = 0; score <= 100; score++) {
      const current = rank[band(score)];
      expect(current, String(score)).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });

  it("handles a fractional score, which is what the provider returns", () => {
    // Azure's accuracy scores are not integers. 79.9 is not an 80.
    expect(band(79.9)).toBe("mid");
    expect(band(80.1)).toBe("hi");
    expect(band(59.999)).toBe("lo");
  });

  it("does not throw on a score outside the range", () => {
    // Nothing should produce these, so the point is only that a surprising
    // provider value bands somewhere rather than rendering unstyled.
    expect(band(-1)).toBe("lo");
    expect(band(1000)).toBe("hi");
    expect(band(NaN)).toBe("lo");
  });
});
