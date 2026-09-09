/**
 * T33 — the resampler, swept.
 *
 * `resample.test.ts` next door checks the filter against chosen tones and the
 * shapes the recorder actually produces. This file states the properties that
 * have to hold for *every* input, because the resampler is the one step in the
 * capture path whose output nobody can eyeball: it produces 16 kHz samples
 * that go straight into a WAV and off to a scorer, and a subtly wrong filter
 * looks exactly like a working pipeline while quietly corrupting the
 * measurement it exists to protect.
 *
 * The strongest property here is superposition. A resampler is a linear
 * time-invariant filter, so `f(a + b)` must equal `f(a) + f(b)` to float
 * precision. Almost every way of getting the polyphase table wrong —
 * a mis-normalised row, a phase picked with the wrong rounding, a tap index
 * off by one — breaks linearity or breaks gain, and this file measures both
 * rather than trusting the arithmetic that produced the table.
 *
 * The numeric tolerances below are measured, not guessed. Each one records
 * what the implementation actually does today and how much room it was given;
 * a regression that pushes past them is a real change in the filter.
 */

import { describe, expect, it } from "vitest";
import { TARGET_SAMPLE_RATE, concatFrames, resampleTo16k } from "./resample.js";
import { floatBetween, intBetween, listOf, makeRng, pickFrom } from "../../testing/rng.js";

const SEED_SIGNALS = 0x5eed_5169;
const SEED_TONES = 0x5eed_7014;

const SIGNAL_CASES = 200;
const TONE_CASES = 40;

/** Every rate a browser AudioContext plausibly reports, plus the extremes. */
const INPUT_RATES = [22050, 32000, 44100, 48000, 88200, 96000, 192000] as const;

function tone(freqHz: number, seconds: number, sampleRate: number): Float32Array {
  const n = Math.floor(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  return out;
}

/**
 * Single-bin DFT — the amplitude of `freqHz` in `signal`, normalised so a
 * full-scale sine at that frequency reads ~1.0. Same measurement
 * scripts/resample-bench.ts uses, so the numbers here are comparable to the
 * ones recorded in resample.ts's header.
 */
function magnitudeAt(signal: Float32Array, freqHz: number, sampleRate: number): number {
  let re = 0;
  let im = 0;
  for (let n = 0; n < signal.length; n++) {
    const phase = (2 * Math.PI * freqHz * n) / sampleRate;
    re += (signal[n] ?? 0) * Math.cos(phase);
    im += (signal[n] ?? 0) * Math.sin(phase);
  }
  return (2 * Math.sqrt(re * re + im * im)) / signal.length;
}

/** Where a tone above the target Nyquist folds to once decimated to 16 kHz. */
function aliasOf(freqHz: number): number {
  const nyquist = TARGET_SAMPLE_RATE / 2;
  let folded = freqHz % TARGET_SAMPLE_RATE;
  if (folded > nyquist) folded = TARGET_SAMPLE_RATE - folded;
  return Math.abs(folded);
}

/** A speech-shaped signal: a few partials, some noise, a plausible envelope. */
function generateSignal(rng: () => number, length: number): Float32Array {
  const out = new Float32Array(length);
  const partials = listOf(intBetween(rng, 1, 4), () => ({
    freq: floatBetween(rng, 80, 4_000),
    amp: floatBetween(rng, 0.05, 0.4),
    phase: floatBetween(rng, 0, Math.PI * 2),
  }));
  for (let i = 0; i < length; i++) {
    let v = 0;
    for (const p of partials) v += p.amp * Math.sin((2 * Math.PI * p.freq * i) / 48_000 + p.phase);
    out[i] = v + floatBetween(rng, -0.02, 0.02);
  }
  return out;
}

describe("the shape of the output", () => {
  it("keeps the decimation arithmetic exact at every rate and length", () => {
    // floor, not round: a partial output sample would be a sample the input
    // does not support, and the lengths that expose that are the short and
    // odd ones rather than the typical ones.
    const lengths = [0, 1, 2, 3, 7, 100, 1_001, 4_800, 48_000];
    for (const rate of INPUT_RATES) {
      for (const length of lengths) {
        const out = resampleTo16k(new Float32Array(length), rate);
        const expected = Math.floor(length / (rate / TARGET_SAMPLE_RATE));
        expect(out.length, `${rate} Hz, ${length} samples`).toBe(expected);
      }
    }
  });

  it("passes the buffer straight through when there is nothing to do", () => {
    /**
     * Identity by reference, not by value. The recorder hands a multi-second
     * Float32Array to this function on every take; copying it when the rate
     * already matches would be a megabyte of pointless allocation on the one
     * code path where the answer is "nothing to do".
     */
    const input = new Float32Array([0.1, -0.2, 0.3]);
    expect(resampleTo16k(input, TARGET_SAMPLE_RATE)).toBe(input);
    // Upsampling is never a real case — every browser AudioContext runs at
    // 44.1 kHz or above — and inventing detail that was never captured would
    // be worse than passing it along.
    for (const rate of [8_000, 11_025, 15_999]) {
      expect(resampleTo16k(input, rate), `${rate} Hz`).toBe(input);
    }
  });

  it("returns silence for silence", () => {
    for (const rate of INPUT_RATES) {
      const out = resampleTo16k(new Float32Array(rate), rate);
      expect(out.length, `${rate} Hz`).toBeGreaterThan(0);
      expect([...out].every((v) => v === 0), `${rate} Hz`).toBe(true);
    }
  });
});

describe("the filter is linear, over generated signals", () => {
  const rng = makeRng(SEED_SIGNALS);
  const cases = listOf(SIGNAL_CASES, (i) => ({
    rate: pickFrom(rng, INPUT_RATES),
    a: generateSignal(rng, 480 + i * 3),
    b: generateSignal(rng, 480 + i * 3),
  }));

  it(`sweeps ${SIGNAL_CASES} signal pairs across every input rate`, () => {
    expect(cases).toHaveLength(SIGNAL_CASES);
    // Every rate actually exercised, so none of the properties below hold
    // only for the one rate the generator happened to like.
    expect(new Set(cases.map((c) => c.rate)).size).toBe(INPUT_RATES.length);
  });

  it("obeys superposition: resampling a sum is summing the resamples", () => {
    /**
     * The property that catches a mis-built polyphase table. Measured worst
     * case today is ~1.2e-7, which is float32 storage error on the inputs;
     * 1e-5 leaves two orders of magnitude of room and still fails outright on
     * any non-linearity worth the name.
     */
    cases.forEach(({ rate, a, b }, i) => {
      const sum = new Float32Array(a.length);
      for (let n = 0; n < a.length; n++) sum[n] = (a[n] ?? 0) + (b[n] ?? 0);

      const ra = resampleTo16k(a, rate);
      const rb = resampleTo16k(b, rate);
      const rsum = resampleTo16k(sum, rate);

      let worst = 0;
      for (let n = 0; n < rsum.length; n++) {
        worst = Math.max(worst, Math.abs((rsum[n] ?? 0) - ((ra[n] ?? 0) + (rb[n] ?? 0))));
      }
      expect(worst, `seed ${SEED_SIGNALS} case ${i} at ${rate} Hz`).toBeLessThan(1e-5);
    });
  });

  it("scales with its input", () => {
    // Homogeneity, the other half of linearity. A table whose rows are
    // normalised per output sample rather than per phase would pass
    // superposition and fail this.
    cases.slice(0, 60).forEach(({ rate, a }, i) => {
      const scaled = new Float32Array(a.length);
      for (let n = 0; n < a.length; n++) scaled[n] = (a[n] ?? 0) * -3;

      const plain = resampleTo16k(a, rate);
      const out = resampleTo16k(scaled, rate);
      let worst = 0;
      for (let n = 0; n < out.length; n++) {
        worst = Math.max(worst, Math.abs((out[n] ?? 0) - (plain[n] ?? 0) * -3));
      }
      expect(worst, `case ${i} at ${rate} Hz`).toBeLessThan(1e-4);
    });
  });

  it("stays finite and bounded, with only the ringing a sharp filter must have", () => {
    /**
     * A windowed-sinc filter overshoots on a sharp transient — that is
     * Gibbs ringing and it is the price of the stopband rejection, not a bug.
     * Measured worst case on a full-scale square wave is ~1.25x the input
     * peak; 1.4 leaves room without letting a lost normalisation (which would
     * change the gain by a factor of tens) through.
     */
    cases.forEach(({ rate, a }, i) => {
      const out = resampleTo16k(a, rate);
      let peakIn = 0;
      for (const v of a) peakIn = Math.max(peakIn, Math.abs(v));
      for (const v of out) {
        expect(Number.isFinite(v), `case ${i} at ${rate} Hz produced ${v}`).toBe(true);
        expect(Math.abs(v), `case ${i} at ${rate} Hz`).toBeLessThanOrEqual(peakIn * 1.4 + 1e-6);
      }
    });
  });

  it("is deterministic, and unaffected by the kernel cache being warm", () => {
    /**
     * The polyphase table is cached per input rate and built once per
     * session. A cache that returned a table built for a different rate — or
     * a table mutated after being handed out — would produce a first take
     * that scores differently from every take after it, which is close to
     * undiagnosable from a learner's report.
     */
    for (const rate of INPUT_RATES) {
      const signal = generateSignal(makeRng(SEED_SIGNALS + rate), 4_800);
      const first = resampleTo16k(signal, rate);
      const second = resampleTo16k(signal, rate);
      // A different rate in between, to prove the cache is keyed rather than
      // just holding the last table it built.
      resampleTo16k(signal, rate === 48_000 ? 44_100 : 48_000);
      const third = resampleTo16k(signal, rate);

      expect([...second], `${rate} Hz`).toEqual([...first]);
      expect([...third], `${rate} Hz`).toEqual([...first]);
    }
  });

  it("puts the output where the input was, to the sub-sample", () => {
    /**
     * Time alignment, which nothing else in this file can see.
     *
     * A tap index off by one shifts the whole signal by one *input* sample —
     * a third of an output sample at 48 kHz. That survives every other
     * property here: it is still linear, still unity-gain, still rejects the
     * same aliases, still the same length. What it breaks is the mapping from
     * output time back to input time, and that mapping is load-bearing:
     * `ScoredSyllable.offsetTicks` is used to slice the learner's own audio
     * for syllable playback, so a drifted resampler plays back the wrong
     * slice of their voice.
     *
     * Measured as exact symmetry rather than as a tolerance. For an integer
     * ratio and an impulse placed on an output sample boundary, the
     * windowed-sinc response is symmetric about that boundary to the last
     * bit — so `out[c - d] === out[c + d]`, and a shift of a third of a
     * sample destroys that equality outright.
     */
    for (const rate of [32_000, 48_000, 96_000, 192_000]) {
      const ratio = rate / TARGET_SAMPLE_RATE;
      expect(Number.isInteger(ratio), `${rate} Hz must have an integer ratio for this test`).toBe(
        true,
      );

      const length = rate;
      const centre = Math.round(length / 2 / ratio);
      const impulse = new Float32Array(length);
      impulse[centre * ratio] = 1;
      const out = resampleTo16k(impulse, rate);

      // Symmetric about the sample the impulse landed on, exactly.
      for (let d = 1; d <= 8; d += 1) {
        expect(out[centre - d], `${rate} Hz, ${d} either side`).toBe(out[centre + d]);
      }
      // And the peak is there, not next to it.
      let peakAt = 0;
      for (let i = 0; i < out.length; i += 1) {
        if (Math.abs(out[i] ?? 0) > Math.abs(out[peakAt] ?? 0)) peakAt = i;
      }
      expect(peakAt, `${rate} Hz`).toBe(centre);

      // The energy centroid too, which catches a shift the peak is too blunt
      // to see.
      let weight = 0;
      let weighted = 0;
      for (let i = 0; i < out.length; i += 1) {
        const w = Math.abs(out[i] ?? 0);
        weight += w;
        weighted += w * i;
      }
      expect(weighted / weight, `${rate} Hz centroid`).toBeCloseTo(centre, 3);
    }
  });

  it("keeps a single bad sample's damage local", () => {
    /**
     * A NaN reaching the filter is not something the capture path should
     * produce, but the kernel is a finite-support convolution and so its
     * blast radius is bounded by design. Worth asserting, because a filter
     * with accumulated state — an IIR, or a running sum — would smear one bad
     * sample across the entire rest of the take, turning a click into a lost
     * recording.
     */
    const rate = 48_000;
    const signal = new Float32Array(48_000).fill(0.3);
    const badAt = 24_000;
    signal[badAt] = Number.NaN;
    const out = resampleTo16k(signal, rate);

    const corrupted = [...out].map((v, i) => (Number.isNaN(v) ? i : -1)).filter((i) => i >= 0);
    expect(corrupted.length).toBeGreaterThan(0);
    // The kernel spans 2 * ceil(8 * ratio) input samples, i.e. ~16 output
    // samples at this rate. A generous ceiling of 64 still fails by three
    // orders of magnitude if the damage ever becomes unbounded.
    expect(corrupted.length).toBeLessThan(64);
    const expectedCentre = Math.round(badAt / (rate / TARGET_SAMPLE_RATE));
    for (const i of corrupted) expect(Math.abs(i - expectedCentre)).toBeLessThan(64);
  });
});

describe("what the filter is for, fuzzed over frequencies", () => {
  const rng = makeRng(SEED_TONES);

  it(`rejects ${TONE_CASES} random tones above the target Nyquist`, () => {
    /**
     * The failure this filter exists to prevent: energy above 8 kHz folds
     * down into the speech band on decimation and lands directly on the
     * fricatives phoneme scoring depends on.
     *
     * Frequencies start at 10 kHz rather than 8 kHz because the Blackman
     * window buys its stopband depth with a wide transition: measured, the
     * alias is 0.26 at 8.6 kHz, 0.038 at 9.6 kHz and 0.011 at 10 kHz. The
     * 10 kHz / 0.05 pair is what resample.ts's header and
     * scripts/resample-bench.ts already claim, so this generalises that exact
     * claim to random frequencies and every input rate instead of one of each.
     */
    let checked = 0;
    for (let i = 0; i < TONE_CASES; i += 1) {
      const rate = pickFrom(rng, INPUT_RATES);
      const ceiling = rate / 2 - 200;
      if (ceiling <= 10_000) continue;
      const freq = floatBetween(rng, 10_000, ceiling);
      const out = resampleTo16k(tone(freq, 0.3, rate), rate);
      const alias = magnitudeAt(out, aliasOf(freq), TARGET_SAMPLE_RATE);
      expect(alias, `seed ${SEED_TONES} case ${i}: ${freq.toFixed(0)}Hz at ${rate}Hz`).toBeLessThan(
        0.05,
      );
      checked += 1;
    }
    // Every rate in the list has a Nyquist above 10 kHz, so nothing should be
    // skipped — asserted so a rate added below 20.4 kHz cannot quietly turn
    // this sweep into a shorter one.
    expect(checked).toBe(TONE_CASES);
  });

  it(`passes ${TONE_CASES} random speech-band tones at near unity gain`, () => {
    // The other half: rejecting the aliases is worthless if it also flattens
    // the speech. Measured worst gain over 150 Hz–6 kHz is 0.9899 at every
    // input rate; 0.95 is the figure the bench asserts.
    for (let i = 0; i < TONE_CASES; i += 1) {
      const rate = pickFrom(rng, INPUT_RATES);
      const freq = floatBetween(rng, 150, 6_000);
      const out = resampleTo16k(tone(freq, 0.3, rate), rate);
      const gain = magnitudeAt(out, freq, TARGET_SAMPLE_RATE);
      expect(
        gain,
        `seed ${SEED_TONES} case ${i}: ${freq.toFixed(0)}Hz at ${rate}Hz`,
      ).toBeGreaterThanOrEqual(0.95);
    }
  });

  it("holds a constant level, away from the edges of the take", () => {
    /**
     * Unity DC gain, which is what per-phase normalisation of the table buys.
     * The first and last few output samples are deliberately excluded: the
     * normalisation assumes the whole tap range is available, which is untrue
     * at the ends of a take. Measured, that costs about ten output samples at
     * each end and nothing in between (interior error ~1.2e-8), which is
     * inaudible against a multi-thousand-sample recording.
     */
    for (const rate of INPUT_RATES) {
      const level = 0.7;
      const out = resampleTo16k(new Float32Array(rate).fill(level), rate);
      const edge = 24;
      for (let i = edge; i < out.length - edge; i += 1) {
        expect(Math.abs((out[i] ?? 0) - level), `${rate} Hz at ${i}`).toBeLessThan(1e-5);
      }
    }
  });
});

describe("flattening the worklet's frames", () => {
  it("concatenates every sample, in order, for any partition", () => {
    const rng = makeRng(SEED_SIGNALS + 7);
    for (let i = 0; i < 200; i += 1) {
      const whole = generateSignal(rng, intBetween(rng, 0, 900));
      // A random partition, including empty frames — the worklet emits those
      // when a render quantum arrives with nothing in it.
      const frames: Float32Array[] = [];
      let offset = 0;
      while (offset < whole.length) {
        const size = intBetween(rng, 0, 128);
        frames.push(whole.slice(offset, offset + size));
        offset += size;
      }
      if (whole.length === 0) frames.push(new Float32Array(0));

      const joined = concatFrames(frames);
      expect(joined.length, `case ${i}`).toBe(whole.length);
      expect([...joined], `case ${i}`).toEqual([...whole]);
      expect(joined.length, `case ${i}`).toBe(frames.reduce((n, f) => n + f.length, 0));
    }
  });

  it("returns an empty buffer for no frames at all", () => {
    expect(concatFrames([]).length).toBe(0);
    expect(concatFrames([new Float32Array(0), new Float32Array(0)]).length).toBe(0);
  });
});
