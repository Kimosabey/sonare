/**
 * The measurement's own integrity, which nothing in the gate was checking.
 *
 * Every score this product has ever produced passed through this file. That
 * makes its failure mode the worst kind: a broken resampler throws nothing and
 * reports nothing — the scores simply get quietly worse, and the numbers keep
 * looking like numbers. This module's own header records that happening once
 * already, when a moving average stood in for the anti-alias filter and "would
 * look like a working pipeline while quietly corrupting the measurement".
 *
 * The properties were verified with `scripts/resample-bench.ts`, which is a
 * bench and not part of `npm test` — so a regression here would ship. These
 * tests move the claims in that header into the gate.
 *
 * Everything below is measured rather than snapshotted. Snapshotting sample
 * values would pin the current kernel's arithmetic and fail on any legitimate
 * tuning of ZERO_CROSSINGS or PHASE_RESOLUTION, while saying nothing about
 * whether the filter still filters.
 */

import { describe, expect, it } from "vitest";
import { concatFrames, resampleTo16k, TARGET_SAMPLE_RATE } from "./resample.js";

/** The two rates a browser AudioContext actually runs at. */
const RATES = [48000, 44100] as const;

function tone(freq: number, rate: number, seconds: number, amp = 1): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let n = 0; n < out.length; n++) out[n] = amp * Math.sin((2 * Math.PI * freq * n) / rate);
  return out;
}

function mix(...signals: Float32Array[]): Float32Array {
  const out = new Float32Array(signals[0]?.length ?? 0);
  for (const s of signals) for (let n = 0; n < out.length; n++) out[n] = (out[n] ?? 0) + (s[n] ?? 0);
  return out;
}

/**
 * The kernel normalizes each phase row assuming every tap is in range, which
 * is not true for the first and last `tapsPerSide` output samples of a take.
 * The header calls that negligible edge error, and it is — but it is a
 * transient, so including it in an RMS measurement of a *rejected* tone would
 * let the edges masquerade as passband energy. Measurements skip the edges and
 * say so, rather than quietly widening a tolerance to absorb them.
 */
const EDGE = 200;

function interior(x: Float32Array): Float32Array {
  return x.subarray(EDGE, Math.max(EDGE, x.length - EDGE));
}

/** For a pure sine over whole cycles, RMS x sqrt(2) is its amplitude. */
function amplitude(x: Float32Array): number {
  let sum = 0;
  for (const v of x) sum += v * v;
  return Math.sqrt(sum / x.length) * Math.SQRT2;
}

/**
 * Amplitude of one frequency component, via a Hann-windowed DFT bin. A plain
 * rectangular bin leaks enough from a full-scale neighbour to swamp a -40 dB
 * stopband reading, which is the range these tests care about.
 */
function amplitudeAt(x: Float32Array, freq: number, rate: number): number {
  let re = 0;
  let im = 0;
  let windowSum = 0;
  for (let n = 0; n < x.length; n++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (x.length - 1));
    const phase = (2 * Math.PI * freq * n) / rate;
    re += (x[n] ?? 0) * w * Math.cos(phase);
    im -= (x[n] ?? 0) * w * Math.sin(phase);
    windowSum += w;
  }
  return (2 * Math.hypot(re, im)) / windowSum;
}

/** Zero-crossing count is a kernel-independent read on "is it still 1 kHz". */
function estimateFreq(x: Float32Array, rate: number): number {
  let crossings = 0;
  for (let n = 1; n < x.length; n++) {
    const prev = x[n - 1] ?? 0;
    const cur = x[n] ?? 0;
    if ((prev < 0 && cur >= 0) || (prev >= 0 && cur < 0)) crossings += 1;
  }
  return (crossings * rate) / (2 * x.length);
}

describe("anti-aliasing — the reason this file exists", () => {
  it.each(RATES)("rejects a 10 kHz tone at %i Hz input", (rate) => {
    /**
     * 10 kHz is above 16 kHz's 8 kHz Nyquist, so it cannot be represented at
     * the target rate. Either the filter removes it, or decimation folds it
     * down to 6 kHz and it arrives as a phantom tone inside the speech band.
     * The header's figure for this is ~0.01 against ~1.0 unfiltered.
     */
    const out = interior(resampleTo16k(tone(10000, rate, 1), rate));

    expect(amplitude(out)).toBeLessThan(0.05);
  });

  it.each(RATES)("puts no phantom tone in the fricative band at %i Hz input", (rate) => {
    /**
     * The specific corruption the header warns about. A 10 kHz input aliases
     * to |10000 - 16000| = 6 kHz, which is where /s/, /ʃ/ and /f/ live — the
     * phonemes scoring depends on most. An unfiltered decimator would show
     * near-full-scale energy at 6 kHz here while every other test on this page
     * still passed.
     */
    const out = interior(resampleTo16k(tone(10000, rate, 1), rate));

    expect(amplitudeAt(out, 6000, TARGET_SAMPLE_RATE)).toBeLessThan(0.05);
  });

  it.each(RATES)("keeps speech and discards the alias from one mixed signal at %i Hz", (rate) => {
    // Both at once, which is what real audio looks like: a voiced 1 kHz
    // component to preserve and a 10 kHz component to remove.
    const input = mix(tone(1000, rate, 1, 0.5), tone(10000, rate, 1, 0.5));
    const out = interior(resampleTo16k(input, rate));

    expect(amplitudeAt(out, 1000, TARGET_SAMPLE_RATE)).toBeGreaterThan(0.45);
    expect(amplitudeAt(out, 6000, TARGET_SAMPLE_RATE)).toBeLessThan(0.05);
  });

  it("keeps every alias quieter than the real content it lands on", () => {
    /**
     * The guarantee that makes the transition band's width acceptable, and the
     * one worth asserting instead of a flat dB figure just above Nyquist.
     *
     * A tone at f (8-16 kHz) folds to 16000 - f. The cutoff sits at 8 kHz with
     * a symmetric rolloff, so gain(f) + gain(16000 - f) is about 1 — meaning
     * gain(f) < 0.5 for every f above 8 kHz, and therefore an alias always
     * arrives *below* the passband gain at the frequency it corrupts. That is
     * why 8.5 kHz surviving at -10.5 dB is a design point rather than a
     * defect: its alias at 7.5 kHz is 7 dB down on genuine 7.5 kHz speech.
     *
     * A filter with the cutoff misplaced would break this while still passing
     * every fixed-threshold stopband test on this page.
     */
    for (const f of [8200, 8500, 9000, 9500, 10000, 12000]) {
      const alias = amplitude(interior(resampleTo16k(tone(f, 48000, 1), 48000)));
      const genuine = amplitude(interior(resampleTo16k(tone(16000 - f, 48000, 1), 48000)));

      expect(alias, `${f} Hz folds to ${16000 - f} Hz`).toBeLessThan(genuine);
      expect(alias, `${f} Hz`).toBeLessThan(0.5);
    }
  });

  it("has the rolloff it is documented to have, measured end to end", () => {
    /**
     * ZERO_CROSSINGS = 8 buys a wide-ish transition band, and nothing recorded
     * where its edges actually sit. Measured here so a change to that constant
     * shows up as a named failure rather than as slightly worse scores:
     *
     *     <=5 kHz  -0.0 dB     9 kHz  -17.0 dB
     *       6 kHz  -0.1 dB    10 kHz  -39.4 dB
     *     7.5 kHz  -3.1 dB    11 kHz  -78.4 dB
     *
     * Bounds are loose enough to survive honest retuning and tight enough that
     * losing the filter, or moving the cutoff, cannot pass.
     */
    const gain = (f: number) => amplitude(interior(resampleTo16k(tone(f, 48000, 1), 48000)));

    expect(gain(5000)).toBeGreaterThan(0.98); // speech band, untouched
    expect(gain(6000)).toBeGreaterThan(0.95); // fricatives, essentially untouched
    expect(gain(7500)).toBeGreaterThan(0.5); // -3 dB point, below cutoff
    expect(gain(7500)).toBeLessThan(0.9);
    expect(gain(10000)).toBeLessThan(0.05); // the header's ~0.01 claim
    expect(gain(12000)).toBeLessThan(0.005); // stopband floor
  });

  it("responds identically at 44.1 kHz and 48 kHz", () => {
    /**
     * The kernel scales its span and cutoff by the input ratio, so the two
     * real browser rates should produce the same filter — a claim the code
     * makes in a comment and nothing checked. A learner on a 44.1 kHz device
     * must not be scored through a differently-tuned filter than one on
     * 48 kHz, because that difference would look like an accent.
     */
    for (const f of [1000, 6000, 7500, 10000]) {
      const at48 = amplitude(interior(resampleTo16k(tone(f, 48000, 1), 48000)));
      const at441 = amplitude(interior(resampleTo16k(tone(f, 44100, 1), 44100)));

      expect(at441, `${f} Hz`).toBeCloseTo(at48, 2);
    }
  });
});

describe("the passband is left alone", () => {
  it.each(RATES)("passes a 1 kHz tone at unity gain from %i Hz", (rate) => {
    // A filter that rejects the stopband by attenuating everything would pass
    // the tests above and destroy the product.
    const out = interior(resampleTo16k(tone(1000, rate, 1), rate));

    expect(amplitude(out)).toBeCloseTo(1, 1);
  });

  it.each(RATES)("preserves pitch from %i Hz, not just amplitude", (rate) => {
    const out = interior(resampleTo16k(tone(1000, rate, 1), rate));

    expect(estimateFreq(out, TARGET_SAMPLE_RATE)).toBeCloseTo(1000, -1);
  });

  it("keeps the fricative band itself, which sits just below Nyquist", () => {
    /**
     * 6 kHz is real /s/ energy and must survive. This is the test that stops
     * "reject the alias" from being solved by simply cutting the top of the
     * band off — which would be indistinguishable from a working filter in
     * every stopband test above, while scoring every sibilant worse.
     */
    const out = interior(resampleTo16k(tone(6000, 48000, 1), 48000));

    expect(amplitude(out)).toBeGreaterThan(0.7);
  });

  it("holds a constant at its own value", () => {
    // Unity DC gain, i.e. the per-phase weight normalization is intact. A row
    // that failed to normalize would show up here as a scaled or rippling
    // output long before it was audible anywhere else.
    const input = new Float32Array(48000).fill(0.25);
    const out = interior(resampleTo16k(input, 48000));

    for (const v of out) expect(v).toBeCloseTo(0.25, 4);
  });

  it("rings within a bounded, amplitude-linear margin at a hard transient", () => {
    /**
     * A windowed sinc overshoots at a step — Gibbs ringing, and correct
     * behaviour for a filter removing the harmonics a square wave has above
     * Nyquist. Measured at 1.149x the input peak.
     *
     * This deliberately does *not* assert the output stays under full scale.
     * It does not, and it is not this module's job to: recorder.ts measures
     * peak *after* resampling and normalises down, commented as "so the sinc
     * kernel's own overshoot is included and the encoder's clamp is guaranteed
     * untouched", and wav.ts clamps as a backstop. Asserting a no-clip
     * property here would put the invariant two layers away from where it is
     * enforced, and would fail the day someone legitimately widened the
     * kernel.
     *
     * What is worth pinning is that the margin stays bounded and scales
     * linearly with input level. Linearity is the real claim: a resampler that
     * had picked up an amplitude-dependent term would no longer be a filter,
     * and every relative level within an utterance — the spectral detail
     * scoring reads — would depend on how loudly the learner spoke.
     */
    const square = (amp: number) => {
      const x = new Float32Array(48000);
      for (let n = 0; n < x.length; n++) x[n] = n % 100 < 50 ? amp : -amp; // 480 Hz
      return x;
    };
    const peak = (x: Float32Array) => {
      let p = 0;
      for (const v of x) p = Math.max(p, Math.abs(v));
      return p;
    };

    const quiet = peak(resampleTo16k(square(0.2), 48000)) / 0.2;
    const loud = peak(resampleTo16k(square(1), 48000)) / 1;

    expect(loud).toBeLessThan(1.25);
    expect(quiet).toBeCloseTo(loud, 3);
  });

  it("attenuates a lone click rather than amplifying it", () => {
    // A single-sample impulse is almost entirely above Nyquist, so most of it
    // is energy the target rate cannot carry. 0.9 in comes out at 0.30 — the
    // filter removing what it should, not a transient sneaking through.
    const click = new Float32Array(48000);
    click[24000] = 0.9;

    let p = 0;
    for (const v of resampleTo16k(click, 48000)) p = Math.max(p, Math.abs(v));
    expect(p).toBeLessThan(0.9);
  });
});

describe("output shape and rate handling", () => {
  it.each(RATES)("returns floor(length / ratio) samples from %i Hz", (rate) => {
    // Duration must survive resampling: the server derives billable seconds
    // from the WAV's own length, so a length bug becomes a billing bug and a
    // wrong auto-stop window at the same time.
    const seconds = 3;
    const out = resampleTo16k(tone(440, rate, seconds), rate);

    expect(out.length).toBe(Math.floor((rate * seconds) / (rate / TARGET_SAMPLE_RATE)));
    expect(out.length / TARGET_SAMPLE_RATE).toBeCloseTo(seconds, 2);
  });

  it("hands back the very same buffer when input is already 16 kHz", () => {
    // Not merely equal — identical. Copying 15 seconds of audio to no purpose
    // is work NFR-02's budget does not have to spare.
    const input = tone(1000, TARGET_SAMPLE_RATE, 1);

    expect(resampleTo16k(input, TARGET_SAMPLE_RATE)).toBe(input);
  });

  it("passes through below 16 kHz rather than fabricating detail", () => {
    // No browser AudioContext runs here, so this is a guard, not a feature.
    // Inventing samples would be inventing evidence for a scorer to read.
    const input = tone(1000, 8000, 1);

    expect(resampleTo16k(input, 8000)).toBe(input);
  });

  it("survives an empty take without throwing", () => {
    // A take cancelled before the first worklet frame arrives.
    expect(resampleTo16k(new Float32Array(0), 48000).length).toBe(0);
  });

  it("handles a take shorter than the kernel is wide", () => {
    /**
     * At 48 kHz the kernel spans 48 taps, so a 20-sample input has no output
     * sample with a full tap range — every one is an edge sample. It must
     * still produce finite numbers rather than NaN.
     */
    const out = resampleTo16k(tone(1000, 48000, 20 / 48000), 48000);

    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });

  it("never emits NaN or Infinity, whatever the input", () => {
    /**
     * The hard invariant. A single NaN becomes a garbage Int16 sample in the
     * WAV, and the provider's response to a corrupt frame is not something
     * this product gets to find out about gracefully.
     */
    const nasty = new Float32Array(48000);
    for (let n = 0; n < nasty.length; n++) nasty[n] = Math.random() * 2 - 1;
    nasty[0] = 1;
    nasty[1] = -1;
    nasty[47999] = 1;

    for (const v of resampleTo16k(nasty, 48000)) expect(Number.isFinite(v)).toBe(true);
  });
});

describe("the kernel cache", () => {
  it("gives identical output on a second call at the same rate", () => {
    // The cache is keyed by input rate and lives for the session. A stale or
    // mutated row would make two takes of the same audio score differently.
    const input = tone(1000, 48000, 0.5);
    const first = resampleTo16k(input, 48000);
    const second = resampleTo16k(input, 48000);

    expect(Array.from(second)).toEqual(Array.from(first));
  });

  it("does not let one rate's kernel serve another", () => {
    /**
     * 48 kHz and 44.1 kHz need different tap counts, so a cache keyed wrongly
     * would return the wrong kernel and mis-tune the cutoff — audible as
     * nothing, measurable only as slightly worse scores. Interleaved on
     * purpose, so a first-write-wins bug cannot pass.
     */
    resampleTo16k(tone(1000, 48000, 0.2), 48000);
    const at441 = interior(resampleTo16k(tone(1000, 44100, 1), 44100));
    resampleTo16k(tone(1000, 48000, 0.2), 48000);
    const rejected = interior(resampleTo16k(tone(10000, 44100, 1), 44100));

    expect(amplitude(at441)).toBeCloseTo(1, 1);
    expect(amplitude(rejected)).toBeLessThan(0.05);
  });

  it("works at an unusual rate no test primed it with", () => {
    // 32 kHz turns up on some Android capture paths. The table is built on
    // demand, so an unseen rate must not be a special case.
    const out = interior(resampleTo16k(tone(1000, 32000, 1), 32000));

    expect(amplitude(out)).toBeCloseTo(1, 1);
  });
});

describe("concatFrames", () => {
  it("joins the worklet's frames in order", () => {
    // Order is the whole job. Reordered frames would still produce a valid
    // WAV of the right length containing scrambled speech.
    const out = concatFrames([
      new Float32Array([1, 2]),
      new Float32Array([3]),
      new Float32Array([4, 5, 6]),
    ]);

    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("returns an empty buffer for no frames", () => {
    expect(concatFrames([]).length).toBe(0);
  });

  it("skips empty frames without leaving a gap", () => {
    // The worklet can post a zero-length frame at a take boundary; a gap here
    // would be silence spliced into the middle of a word.
    const out = concatFrames([new Float32Array([1]), new Float32Array(0), new Float32Array([2])]);

    expect(Array.from(out)).toEqual([1, 2]);
  });

  it("preserves the total sample count across many frames", () => {
    // 128-sample frames are the worklet's real quantum; 15 seconds at 48 kHz
    // is roughly 5600 of them.
    const frames = Array.from({ length: 5625 }, () => new Float32Array(128));

    expect(concatFrames(frames).length).toBe(5625 * 128);
  });
});
