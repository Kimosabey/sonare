/**
 * Signal analysis, with the clipping case pinned deliberately.
 *
 * A real learner attempt on 2026-09-02 measured 37.8 dB SNR — the best of
 * three takes — while peaking at +6.3 dBFS, and Azure returned NoMatch ("no
 * speech recognised") on it. The learner had spoken clearly and loudly. The
 * SNR gate passed the single worst recording of the session because clipping
 * *improves* the metric it gates on, so `clippedFraction` exists as a
 * separate signal and these tests hold that separation in place.
 */

import { describe, expect, it } from "vitest";
import { analyseSignal } from "./snr.js";

const RATE = 16000;

/** A clean sine at the given amplitude — a stand-in for well-levelled speech. */
function tone(seconds: number, amplitude: number, freq = 220): Float32Array {
  const n = Math.round(seconds * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / RATE);
  }
  return out;
}

/** The same tone driven past full scale, as an over-driven input arrives. */
function overdriven(seconds: number, gain: number, freq = 220): Float32Array {
  const out = tone(seconds, 1, freq);
  for (let i = 0; i < out.length; i += 1) out[i] = (out[i] ?? 0) * gain;
  return out;
}

describe("analyseSignal — clipping", () => {
  it("reports effectively no clipping for a well-levelled take", () => {
    const stats = analyseSignal(tone(1, 0.5), RATE);

    expect(stats.clippedFraction).toBe(0);
    expect(stats.peakDbfs).toBeLessThan(0);
    expect(stats.silent).toBe(false);
  });

  it("reports a large clipped fraction for an over-driven take", () => {
    // gain 2.0 puts roughly a third of a sine above full scale.
    const stats = analyseSignal(overdriven(1, 2), RATE);

    expect(stats.clippedFraction).toBeGreaterThan(0.2);
    // Positive dBFS is the arithmetic tell: it cannot happen in clean audio.
    expect(stats.peakDbfs).toBeGreaterThan(0);
  });

  it("does not flag a single transient touching full scale", () => {
    // One plosive or table knock must never reject an otherwise good take.
    const samples = tone(1, 0.5);
    for (let i = 100; i < 140; i += 1) samples[i] = 1;

    const stats = analyseSignal(samples, RATE);

    expect(stats.clippedFraction).toBeGreaterThan(0);
    expect(stats.clippedFraction).toBeLessThan(0.02);
  });

  it("SNR cannot detect clipping — the reason this metric had to be separate", () => {
    // The regression this whole gate exists for. If a future refactor makes
    // clipping detectable via snrDb alone, this assertion is what should fail
    // and prompt re-reading the gate.
    const clipped = analyseSignal(overdriven(1, 2), RATE);
    const clean = analyseSignal(tone(1, 0.5), RATE);

    expect(clipped.clippedFraction).toBeGreaterThan(0.2);
    // The destroyed take's SNR is no worse than the good one's.
    expect(clipped.snrDb).toBeGreaterThanOrEqual(clean.snrDb - 1);
  });

  it("still reports silence for an empty room", () => {
    const stats = analyseSignal(new Float32Array(RATE), RATE);

    expect(stats.silent).toBe(true);
    expect(stats.clippedFraction).toBe(0);
  });

  it("returns a usable shape for a take too short to frame", () => {
    const stats = analyseSignal(tone(0.001, 0.5), RATE);

    expect(Number.isFinite(stats.snrDb)).toBe(true);
    expect(Number.isFinite(stats.clippedFraction)).toBe(true);
  });
});
