/**
 * T33 — the score-to-band mapping, swept.
 *
 * `band()` is eleven lines and it decides what colour a learner's score is,
 * everywhere: word chips, phoneme rows, trajectory steps. It has already been
 * wrong once in a way nothing caught — it returned hi/mid/lo against a
 * stylesheet keyed on pass/warn/fail, so every score rendered the same colour
 * and the banding silently stopped existing. `scripts/verify.mjs` T12 now
 * holds the stylesheet to whatever `band()`'s return type says, which closes
 * the *naming* half of that failure.
 *
 * This file closes the *arithmetic* half. Two thresholds and three outputs is
 * a small enough space to sweep exhaustively rather than sample, so that is
 * what happens here: every hundredth of a point from -10 to 110, plus the
 * float neighbourhood of each boundary, plus a seeded fuzz over the values
 * that have broken threshold arithmetic before.
 *
 * The property that actually matters is monotonicity. A learner who scores
 * higher must never be shown a worse band, and that is a statement about
 * every pair of scores rather than about any one of them.
 */

import { describe, expect, it } from "vitest";
import { band } from "./band.js";
import { NASTY_NUMBERS, floatBetween, makeRng, pickFrom } from "../../testing/rng.js";

const SEED_BAND = 0x5eed_ba7d;
const FUZZ_CASES = 5_000;

/** The documented thresholds, named so the tests read as the rule. */
const HI_FROM = 80;
const MID_FROM = 60;

/** Worst to best, so "never shows a worse band for a better score" is `<=`. */
const RANK: Record<ReturnType<typeof band>, number> = { lo: 0, mid: 1, hi: 2 };

function expected(score: number): ReturnType<typeof band> {
  if (score >= HI_FROM) return "hi";
  if (score >= MID_FROM) return "mid";
  return "lo";
}

/** Every hundredth of a point across the range, and well past both ends. */
function exhaustiveSweep(): number[] {
  const out: number[] = [];
  for (let hundredths = -1_000; hundredths <= 11_000; hundredths += 1) {
    out.push(hundredths / 100);
  }
  return out;
}

describe("the band mapping, swept exhaustively", () => {
  const sweep = exhaustiveSweep();

  it("covers the whole range at a hundredth of a point", () => {
    // Stated so a later edit that shrinks the sweep is visible rather than
    // quietly making every assertion below cheaper.
    expect(sweep).toHaveLength(12_001);
    expect(sweep[0]).toBe(-10);
    expect(sweep[sweep.length - 1]).toBe(110);
  });

  it("returns one of exactly three bands, and all three are reachable", () => {
    const seen = new Set<string>();
    for (const score of sweep) seen.add(band(score));
    expect([...seen].sort()).toEqual(["hi", "lo", "mid"]);
  });

  it("agrees with the documented thresholds at every point", () => {
    for (const score of sweep) {
      expect(band(score), `score ${score}`).toBe(expected(score));
    }
  });

  it("never shows a worse band for a better score", () => {
    /**
     * The invariant a banding function exists to have. Checked pairwise along
     * the ordered sweep, which is enough: rank is non-decreasing along a
     * sorted list if and only if it is monotone over every pair.
     */
    let previous = RANK[band(sweep[0] ?? 0)];
    for (const score of sweep) {
      const rank = RANK[band(score)];
      expect(rank, `score ${score} went backwards`).toBeGreaterThanOrEqual(previous);
      previous = rank;
    }
  });

  it("changes band exactly twice across the range", () => {
    // A third boundary — or a missing one — is the shape of a threshold
    // edited in one branch and not the other.
    let changes = 0;
    let previous = band(sweep[0] ?? 0);
    const at: number[] = [];
    for (const score of sweep) {
      const current = band(score);
      if (current !== previous) {
        changes += 1;
        at.push(score);
      }
      previous = current;
    }
    expect(changes).toBe(2);
    expect(at).toEqual([MID_FROM, HI_FROM]);
  });
});

describe("the boundaries themselves", () => {
  it("includes the threshold and excludes the point below it", () => {
    // Inclusive on the lower edge, per the doc comment: "≥80 pass, 60–79
    // warn". `>` where `>=` belongs would move both boundaries one step and
    // is invisible on integers a whole point apart.
    expect(band(MID_FROM)).toBe("mid");
    expect(band(HI_FROM)).toBe("hi");

    for (const boundary of [MID_FROM, HI_FROM]) {
      const below = boundary - Number.EPSILON * boundary;
      expect(below, `${boundary} minus one ulp must be a distinct number`).toBeLessThan(boundary);
      expect(band(below), `one ulp below ${boundary}`).toBe(
        boundary === HI_FROM ? "mid" : "lo",
      );
    }
  });

  it("holds across the float neighbourhood of each boundary", () => {
    for (const boundary of [MID_FROM, HI_FROM]) {
      for (const delta of [-1, -0.5, -0.1, -0.01, -0.001, 0, 0.001, 0.01, 0.1, 0.5, 1]) {
        const score = boundary + delta;
        expect(band(score), `${boundary} ${delta >= 0 ? "+" : ""}${delta}`).toBe(expected(score));
      }
    }
  });
});

describe("the band mapping, fuzzed", () => {
  it(`holds over ${FUZZ_CASES} generated scores including the nasty ones`, () => {
    const rng = makeRng(SEED_BAND);
    const counts = { hi: 0, mid: 0, lo: 0 };

    for (let i = 0; i < FUZZ_CASES; i += 1) {
      // A third of the cases are values that have actually broken threshold
      // arithmetic; the rest spread across and beyond the plausible range.
      const score = i % 3 === 0 ? pickFrom(rng, NASTY_NUMBERS) : floatBetween(rng, -20, 120);
      const result = band(score);
      const where = `seed ${SEED_BAND} case ${i} score ${score}`;

      expect(["hi", "mid", "lo"], where).toContain(result);
      expect(result, where).toBe(expected(score));
      counts[result] += 1;
    }

    // Every band was actually produced, so none of the above passed by never
    // being asked.
    expect(counts.hi).toBeGreaterThan(0);
    expect(counts.mid).toBeGreaterThan(0);
    expect(counts.lo).toBeGreaterThan(0);
  });

  it("is total: no input produces undefined", () => {
    // Includes the values a score should never be. `band()` is fed
    // `word.accuracy` straight from a provider response and from progress
    // restored out of browser storage, neither of which the type system can
    // vouch for. (Naming the browser API here would trip verify.mjs's R11,
    // which forbids that token anywhere under src/speech/ — correctly.)
    const hostile = [
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
      Number.MIN_VALUE,
      -0,
      0,
    ];
    for (const score of hostile) {
      expect(["hi", "mid", "lo"], `score ${score}`).toContain(band(score));
    }
    expect(band(Number.POSITIVE_INFINITY)).toBe("hi");
    expect(band(Number.NEGATIVE_INFINITY)).toBe("lo");
  });

  it("falls to the bottom band for a number that is not one", () => {
    /**
     * NaN compares false against everything, so both thresholds miss and the
     * result is `lo`.
     *
     * Pinned rather than endorsed. `lo` is the *safe* fallback of the three —
     * a colour, not a claim, and it does not tell a learner they did well —
     * but it is still a band shown for a score that does not exist. R8 is what
     * keeps that unreachable in practice: an unmeasured take carries
     * `accuracy: null` and never gets as far as banding, so nothing upstream
     * hands NaN to this function. If that ever changes, this test is where the
     * question surfaces.
     */
    expect(band(Number.NaN)).toBe("lo");
  });
});
