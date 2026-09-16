/**
 * N8 — formant accuracy against published reference vowels.
 *
 * The references are Peterson & Barney (1952), the measurement every phonetics
 * text still quotes: average F1/F2/F3 for ten American English vowels from 76
 * speakers. They are used here because they are *published* — a bar somebody
 * else set, which is the only kind worth measuring against. A test written
 * around whatever this estimator happens to produce would pass forever and
 * vouch for nothing.
 *
 * The vowels are synthesised rather than recorded: a source-filter model with
 * resonators at the published frequencies, so the right answer is known
 * exactly. That makes this a test of the estimator and not of a recording, and
 * it is the reason a number here can be asserted at all.
 *
 * ## What this found
 *
 * The estimator shipped nowhere and was parked with the note that its errors
 * ran to 1587 Hz. This file is where that stopped being a note. The error was
 * not diffuse — it was specific and diagnosable: **every one of the bad cases
 * was a back rounded vowel**, where F1 and F2 sit close enough for a
 * too-low-order fit to merge them, after which F3 is taken as F2. Raising the
 * order fixed it, and the sweep is recorded on `LPC_ORDER`.
 *
 * ## What it still cannot do
 *
 * F1 is wrong above roughly 140 Hz of fundamental — see the last describe.
 * That failure is **order-independent**: it is identical at every order from
 * 20 to 34, because it is LPC fitting a harmonic rather than a formant, which
 * is a different problem from the one solved here. Higher-pitched voices —
 * most women, all children — are therefore not measurable by this, and the
 * vowel chart stays unshipped for that reason. It is asserted below rather
 * than described, so that anyone who fixes it finds out immediately.
 */

import { describe, expect, it } from "vitest";
import { estimateFormants } from "./formants.js";

const SAMPLE_RATE = 16_000;

/** One resonator, in place. */
function resonate(signal: Float64Array, frequency: number, bandwidth: number, rate: number): void {
  const r = Math.exp((-Math.PI * bandwidth) / rate);
  const theta = (2 * Math.PI * frequency) / rate;
  const b1 = 2 * r * Math.cos(theta);
  const b2 = -(r * r);
  const gain = 1 - b1 - b2;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < signal.length; i++) {
    const y = gain * (signal[i] ?? 0) + b1 * y1 + b2 * y2;
    signal[i] = y;
    y2 = y1;
    y1 = y;
  }
}

/**
 * A synthetic vowel: a glottal pulse train through resonators at the given
 * formants, differentiated for lip radiation. The classic source-filter model.
 */
function vowel(f1: number, f2: number, f3: number, f0 = 120, seconds = 0.3): Float32Array {
  const length = Math.round(seconds * SAMPLE_RATE);
  const signal = new Float64Array(length);
  const period = SAMPLE_RATE / f0;
  for (let p = 0; p * period < length; p++) signal[Math.round(p * period)] = 1;

  // Two low poles for the glottal source's spectral tilt.
  resonate(signal, 0, 200, SAMPLE_RATE);
  resonate(signal, 0, 200, SAMPLE_RATE);
  resonate(signal, f1, 60, SAMPLE_RATE);
  resonate(signal, f2, 90, SAMPLE_RATE);
  resonate(signal, f3, 120, SAMPLE_RATE);
  // Two above the band of interest, so the fit has somewhere to put its
  // remaining poles other than inside F1 and F2.
  resonate(signal, 3800, 200, SAMPLE_RATE);
  resonate(signal, 4600, 250, SAMPLE_RATE);

  const radiated = new Float64Array(length);
  for (let i = 1; i < length; i++) radiated[i] = (signal[i] ?? 0) - (signal[i - 1] ?? 0);

  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(radiated[i] ?? 0));

  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = ((radiated[i] ?? 0) / peak) * 0.7;
  return out;
}

/** Peterson & Barney (1952), male averages, in Hz. */
const REFERENCE: [name: string, f1: number, f2: number, f3: number][] = [
  ["i (heed)", 270, 2290, 3010],
  ["ɪ (hid)", 390, 1990, 2550],
  ["ɛ (head)", 530, 1840, 2480],
  ["æ (had)", 660, 1720, 2410],
  ["ɑ (hod)", 730, 1090, 2440],
  ["ɔ (hawed)", 570, 840, 2410],
  ["ʊ (hood)", 440, 1020, 2240],
  ["u (who'd)", 300, 870, 2240],
  ["ʌ (hud)", 640, 1190, 2390],
  ["ɝ (heard)", 490, 1350, 1690],
];

/**
 * The bar.
 *
 * 60 Hz is under the width of a formant's own bandwidth and well under the
 * distance between neighbouring vowels — /ɪ/ and /ɛ/ are 140 Hz apart in F1,
 * so an estimate inside 60 cannot be confused for the vowel next door, which
 * is the only accuracy that matters for a chart a learner reads.
 */
const TOLERANCE_HZ = 60;

describe("against Peterson & Barney", () => {
  it.each(REFERENCE)("measures %s", (name, f1, f2, f3) => {
    const outcome = estimateFormants(vowel(f1, f2, f3), SAMPLE_RATE);

    /**
     * A refusal is an acceptable answer and a wrong number is not. /u/ refuses
     * as unstable at this order — its F1 and F2 are 570 Hz apart with F1 at
     * 300, which is the hardest case in the set — and refusing is exactly
     * right: the chart can say nothing rather than place the point on the
     * wrong vowel.
     */
    if (outcome.kind === "refused") {
      expect(outcome.reason, name).toBeTruthy();
      return;
    }

    expect(Math.abs(outcome.f1Hz - f1), `${name} F1: got ${outcome.f1Hz.toFixed(0)}`).toBeLessThan(
      TOLERANCE_HZ,
    );
    expect(Math.abs(outcome.f2Hz - f2), `${name} F2: got ${outcome.f2Hz.toFixed(0)}`).toBeLessThan(
      TOLERANCE_HZ,
    );
  });

  /**
   * A guard, because the case above accepts a refusal. If the estimator
   * started refusing everything it would pass ten times over while measuring
   * nothing — which is the shape this whole file exists to avoid.
   */
  it("actually measures nearly all of them, rather than refusing its way to a pass", () => {
    const measured = REFERENCE.filter(
      ([, f1, f2, f3]) => estimateFormants(vowel(f1, f2, f3), SAMPLE_RATE).kind === "measured",
    );

    expect(measured.length).toBeGreaterThanOrEqual(REFERENCE.length - 1);
  });

  /**
   * The failure that motivated the order change, pinned so it cannot come
   * back. At order 18 this F2 came out at 2427 against a true 840 — the
   * estimator had found F3 and called it F2, which places /ɔ/ where /ɛ/ lives.
   */
  it("does not mistake F3 for F2 on a back rounded vowel", () => {
    const outcome = estimateFormants(vowel(570, 840, 2410), SAMPLE_RATE);

    expect(outcome.kind).toBe("measured");
    if (outcome.kind !== "measured") return;
    expect(outcome.f2Hz, `got ${outcome.f2Hz.toFixed(0)}, F3 is 2410`).toBeLessThan(1200);
  });
});

describe("the limit that keeps the vowel chart unshipped", () => {
  /**
   * F1 is wrong above roughly 140 Hz of fundamental, and **confidently** so —
   * the spread guard reports 0, so the estimator does not know it is wrong.
   * That is the worst combination available: a number, delivered with
   * confidence, about a learner's mouth, that is out by hundreds of Hz.
   *
   * Order-independent — identical from 20 to 34 — because it is LPC fitting a
   * harmonic rather than a formant. Most women and all children speak above
   * this, so it is not an edge case; it is most of the population.
   *
   * Asserted rather than described so that whoever fixes it finds out here
   * instead of in a review. When this test starts failing, that is the good
   * news, and the vowel chart becomes a decision rather than a defect.
   */
  it.each([150, 200, 250])("is still wrong about F1 at f0 = %i Hz", (f0) => {
    const outcome = estimateFormants(vowel(530, 1840, 2480, f0), SAMPLE_RATE);

    if (outcome.kind === "refused") return; // Refusing would be a fix, not a failure.
    expect(
      Math.abs(outcome.f1Hz - 530),
      `f0=${String(f0)} now measures F1 at ${outcome.f1Hz.toFixed(0)} — if this is within ` +
        `tolerance the limitation is gone and the chart can be reconsidered`,
    ).toBeGreaterThan(TOLERANCE_HZ);
  });

  it("is accurate at a low fundamental, which is what makes the above a pitch problem", () => {
    const outcome = estimateFormants(vowel(530, 1840, 2480, 110), SAMPLE_RATE);

    expect(outcome.kind).toBe("measured");
    if (outcome.kind !== "measured") return;
    expect(Math.abs(outcome.f1Hz - 530)).toBeLessThan(TOLERANCE_HZ);
  });
});
