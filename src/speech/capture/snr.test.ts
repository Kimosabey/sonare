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
import { analyseSignal, frameLevelDbfs, framePeakDbfs, peakAmplitude } from "./snr.js";

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

/**
 * The arithmetic that decides what a learner is told.
 *
 * `HEARD_SPEECH_SNR_DB = 10` picks between two pieces of advice on an
 * indeterminate take — "try again a little louder" and "we heard you clearly,
 * try it slower" — and at the 9.4% indeterminate rate this project measures,
 * that branch is taken about once in eleven takes. Advice on the wrong side of
 * it sends a learner to debug a microphone that is working perfectly, and the
 * next take fails the same way.
 *
 * These were written after a mutation sweep found the numbers unpinned: the
 * frame size, the RMS divisor and the percentile clamp could all be inverted
 * with every existing test still passing. The code was right; nothing was
 * holding it there.
 */
describe("analyseSignal — the SNR figure itself", () => {
  /**
   * Speech-like frames at `speech`, room tone at `noise`, alternating on the
   * analyser's own 20 ms window — so the blocks have to be built at the rate
   * the take will be analysed at. Building them at one rate and analysing at
   * another averages several blocks into each frame and collapses the
   * separation, which is correct behaviour and not what these tests are for.
   */
  function speechInRoom(seconds: number, speech: number, noise: number, rate = RATE): Float32Array {
    const n = Math.round(seconds * rate);
    const out = new Float32Array(n);
    const frame = Math.round((rate * 20) / 1000);
    for (let i = 0; i < n; i += 1) {
      const loud = Math.floor(i / frame) % 2 === 0;
      out[i] = (loud ? speech : noise) * Math.sin((2 * Math.PI * 220 * i) / rate);
    }
    return out;
  }

  it("reports the ratio between speech frames and room frames", () => {
    // 0.3 against 0.003 is 40 dB of separation by construction. The measured
    // figure has to land on it, not merely be "large".
    const stats = analyseSignal(speechInRoom(1, 0.3, 0.003), RATE);

    expect(stats.snrDb).toBeGreaterThan(35);
    expect(stats.snrDb).toBeLessThan(45);
  });

  it("tracks the separation rather than the absolute level", () => {
    /**
     * The property the advice depends on. A quiet speaker in a quiet room is
     * audible and must not be told to speak up; a loud speaker in a loud room
     * is the one who needs a quieter place. Halving both levels must leave the
     * figure alone.
     */
    const loud = analyseSignal(speechInRoom(1, 0.4, 0.004), RATE);
    const quiet = analyseSignal(speechInRoom(1, 0.04, 0.0004), RATE);

    expect(quiet.snrDb).toBeCloseTo(loud.snrDb, 0);
  });

  it("lands below the advice threshold for a genuinely quiet take", () => {
    // Under 10 dB is the "try again a little louder" branch, and it has to be
    // reached by a take that really is too quiet to read.
    const stats = analyseSignal(speechInRoom(1, 0.02, 0.012), RATE);

    expect(stats.snrDb).toBeLessThan(10);
  });

  it("lands above it for a take that was clearly heard", () => {
    /**
     * Real takes on this project measured 12.8–33 dB and scored 93–99, so
     * anything in that band must read as heard — otherwise a learner who spoke
     * perfectly well is told to speak up.
     */
    const stats = analyseSignal(speechInRoom(1, 0.25, 0.02), RATE);

    expect(stats.snrDb).toBeGreaterThan(10);
  });

  it("frames on a 20 ms window, not per sample", () => {
    /**
     * Kills the `Math.max(1, …)` mutant on the frame size. With a frame of one
     * sample the percentiles run over instantaneous amplitudes of a waveform
     * that crosses zero every cycle, so the 10th percentile is near-silence for
     * *any* input and the SNR becomes a property of the waveform rather than of
     * the room. A steady tone must therefore report almost no separation.
     */
    const steady = tone(1, 0.3);

    expect(analyseSignal(steady, RATE).snrDb).toBeLessThan(6);
  });

  it("scales its frame with the sample rate", () => {
    // 20 ms is 320 samples at 16 kHz and 960 at 48 kHz. A fixed count would
    // silently analyse a different window on a device-rate take.
    const at16k = analyseSignal(speechInRoom(1, 0.3, 0.003, 16000), 16000);
    const at48k = analyseSignal(speechInRoom(1, 0.3, 0.003, 48000), 48000);

    // The same room, measured on the same 20 ms of audio, reports the same
    // separation whatever the device rate — which is what lets one SNR
    // threshold serve every platform in the fixture.
    expect(at16k.snrDb).toBeGreaterThan(30);
    expect(at48k.snrDb).toBeCloseTo(at16k.snrDb, 0);
  });

  it("does not report an infinite ratio for a digitally silent room", () => {
    /**
     * Kills the `Math.max(noise, SILENCE_FLOOR)` mutant. Exact zeros in the
     * quiet frames make the denominator zero, and `toDb(0)` is -Infinity — so
     * the SNR becomes Infinity, which propagates into the attempt record and
     * out to the diagnostics mean as a value no arithmetic recovers from.
     */
    const n = RATE;
    const samples = new Float32Array(n);
    const frame = Math.round((RATE * 20) / 1000);
    for (let i = 0; i < n; i += 1) {
      if (Math.floor(i / frame) % 2 === 0) samples[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / RATE);
      // else: exact digital silence
    }

    const stats = analyseSignal(samples, RATE);

    expect(Number.isFinite(stats.snrDb)).toBe(true);
    expect(stats.snrDb).toBeGreaterThan(0);
  });

  it("never reports a negative fraction or an unbounded one", () => {
    // clippedFraction feeds a learner-facing warning, so it has to be a real
    // proportion whatever arrives.
    for (const samples of [tone(0.5, 0.3), overdriven(0.5, 4), new Float32Array(0), new Float32Array(8)]) {
      const stats = analyseSignal(samples, RATE);
      expect(stats.clippedFraction).toBeGreaterThanOrEqual(0);
      expect(stats.clippedFraction).toBeLessThanOrEqual(1);
    }
  });
});

/**
 * The three per-frame helpers, which had no tests and drive everything the
 * learner sees while recording.
 *
 * `frameLevelDbfs` is the number the live meter renders, thirty times a
 * second, and the number the endpointer calibrates its speech threshold
 * against — so an error here is simultaneously a wrong meter and an auto-stop
 * that fires at the wrong moment. A mutation sweep could invert its RMS
 * divisor with the whole suite still green.
 *
 * `framePeakDbfs` exists separately because RMS cannot see clipping: audio
 * peaking at +7.9 dBFS still reads around -8 dBFS RMS, so the meter looks
 * healthy while every loud syllable is being flattened. Keeping the two
 * genuinely different is the property under test.
 */
describe("frameLevelDbfs — the meter's own number", () => {
  /** One frame of a sine at `amplitude`, whole cycles so RMS is exact. */
  function frame(amplitude: number, cycles = 4, length = 320): Float32Array {
    const out = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      out[i] = amplitude * Math.sin((2 * Math.PI * cycles * i) / length);
    }
    return out;
  }

  it("reports RMS, which for a sine is 3 dB below its peak", () => {
    /**
     * The exact relationship, and what kills the divisor mutant: a full-scale
     * sine is -3.01 dBFS RMS. Dividing by anything but the frame length gives
     * a number tens of dB out, which would put the meter hard against its top
     * for every frame of every take.
     */
    expect(frameLevelDbfs(frame(1))).toBeCloseTo(-3.01, 1);
    expect(frameLevelDbfs(frame(0.5))).toBeCloseTo(-9.03, 1);
    expect(frameLevelDbfs(frame(0.1))).toBeCloseTo(-23.01, 1);
  });

  it("does not depend on the frame length", () => {
    // The worklet's quantum is 128 but frames are batched; the same audio must
    // read the same level however it was chunked, or the meter would jump on a
    // buffer-size change and the endpointer's floor would move with it.
    const short = frameLevelDbfs(frame(0.3, 2, 128));
    const long = frameLevelDbfs(frame(0.3, 16, 1024));

    expect(short).toBeCloseTo(long, 1);
  });

  it("halving the amplitude costs exactly 6 dB", () => {
    // A meter whose scale was not logarithmic-in-amplitude would still look
    // plausible while misrepresenting how much louder a learner got.
    const loud = frameLevelDbfs(frame(0.4));
    const half = frameLevelDbfs(frame(0.2));

    expect(loud - half).toBeCloseTo(6.02, 1);
  });

  it("returns a floor rather than -Infinity for a silent frame", () => {
    /**
     * Silence between words is the commonest frame in any take. -Infinity
     * would poison the endpointer's noise-floor estimate and render as an
     * empty or broken meter, so there has to be a finite bottom.
     */
    const level = frameLevelDbfs(new Float32Array(320));

    expect(Number.isFinite(level)).toBe(true);
    expect(level).toBeLessThan(-90);
  });

  it("survives an empty frame without dividing by zero", () => {
    // The `Math.max(1, …)` guard. A worklet can post a zero-length frame at a
    // take boundary.
    expect(Number.isFinite(frameLevelDbfs(new Float32Array(0)))).toBe(true);
  });

  it("is monotonic in level", () => {
    let previous = -Infinity;
    for (const amplitude of [0, 0.001, 0.01, 0.1, 0.3, 0.6, 1]) {
      const level = frameLevelDbfs(frame(amplitude));
      expect(level, String(amplitude)).toBeGreaterThanOrEqual(previous);
      previous = level;
    }
  });
});

describe("framePeakDbfs — what RMS cannot see", () => {
  it("reads full scale for a full-scale sine, where RMS reads -3", () => {
    /**
     * The separation the clipping warning depends on. If peak tracked RMS
     * there would be nothing to warn from, and an over-driven take would show
     * a healthy meter right up until the scorer rejected it.
     */
    const out = new Float32Array(320);
    for (let i = 0; i < out.length; i += 1) out[i] = Math.sin((2 * Math.PI * 4 * i) / 320);

    expect(framePeakDbfs(out)).toBeCloseTo(0, 1);
    expect(frameLevelDbfs(out)).toBeCloseTo(-3.01, 1);
  });

  it("goes above full scale on an over-driven frame", () => {
    /**
     * Web Audio Float32 is not clamped to +/-1, so this genuinely happens —
     * and a positive dBFS is exactly the signal the warning needs. Clamping it
     * to 0 would make an over-driven frame indistinguishable from a
     * well-levelled one.
     */
    const out = new Float32Array(320).fill(2);

    expect(framePeakDbfs(out)).toBeGreaterThan(0);
  });

  it("sees a single transient that RMS averages away", () => {
    // One clipped sample in 320 barely moves the RMS and is the whole of what
    // the peak is for.
    const out = new Float32Array(320);
    out[100] = 1;

    expect(framePeakDbfs(out)).toBeCloseTo(0, 1);
    expect(frameLevelDbfs(out)).toBeLessThan(-20);
  });

  it("returns a finite floor for silence", () => {
    expect(Number.isFinite(framePeakDbfs(new Float32Array(320)))).toBe(true);
  });
});

describe("peakAmplitude", () => {
  it("takes the largest magnitude regardless of sign", () => {
    // A negative peak clips just as hard as a positive one, and speech is not
    // symmetric.
    expect(peakAmplitude(new Float32Array([0.2, -0.9, 0.5]))).toBeCloseTo(0.9, 6);
  });

  it("is zero for silence and for an empty buffer", () => {
    expect(peakAmplitude(new Float32Array(16))).toBe(0);
    expect(peakAmplitude(new Float32Array(0))).toBe(0);
  });

  it("does not clamp above full scale", () => {
    // The recorder normalises against this value, so clamping here would make
    // it normalise against the wrong peak and leave the encoder to clip.
    expect(peakAmplitude(new Float32Array([1.5]))).toBeCloseTo(1.5, 6);
  });
});

/**
 * What a mutation sweep could and could not reach, recorded so the next one
 * does not spend time re-deriving it.
 *
 * Two survivors are *unkillable by construction* rather than untested:
 *
 *  - `samples[i] ?? 0` becoming `samples[i] || 0` on a numeric array read.
 *    `0 || 0` is 0 and `undefined || 0` is 0, so the two are identical; the
 *    fallback exists only because `noUncheckedIndexedAccess` requires one.
 *
 *  - `>= CLIP_AMPLITUDE` becoming `>`. The threshold is 0.999, and the nearest
 *    float32 to 0.999 is 0.999000012874…, strictly *above* it — so no
 *    Float32Array sample can ever land exactly on the boundary and both
 *    operators count every reachable value identically. The boundary is not
 *    unpinned, it is unobservable through the type the audio arrives in.
 */
describe("boundaries", () => {
  it("counts a saturating converter's output as clipped", () => {
    /**
     * CLIP_AMPLITUDE is 0.999 rather than 1.0 because a converter that
     * saturates lands just under full scale — so the threshold has to catch
     * that, not only exact unity.
     */
    const saturated = new Float32Array(1000).fill(0.999);
    const justUnder = new Float32Array(1000).fill(0.99);

    expect(analyseSignal(saturated, RATE).clippedFraction).toBeCloseTo(1, 3);
    expect(analyseSignal(justUnder, RATE).clippedFraction).toBe(0);
  });

  it("analyses every complete frame, including the last one", () => {
    /**
     * The loop bound, `start + frameSize <= samples.length`. Built so the
     * final complete frame is the only loud one: with `<` it is dropped, the
     * remaining frames are all room tone, and the take reads as having no
     * speech in it at all — which would show a learner a quiet-take warning on
     * audio that was perfectly audible.
     *
     * Asserted on `snrDb`, because that is the figure derived from the frames.
     * `peakDbfs` and `silent` are computed over the whole buffer and would
     * pass either way — which is how the first version of this test missed.
     */
    const frameSize = Math.round((RATE * 20) / 1000);
    const frames = 6;
    const samples = new Float32Array(frameSize * frames);
    for (let i = 0; i < samples.length; i += 1) {
      const isLast = i >= frameSize * (frames - 1);
      samples[i] = (isLast ? 0.5 : 0.0005) * Math.sin((2 * Math.PI * 220 * i) / RATE);
    }

    const stats = analyseSignal(samples, RATE);

    expect(stats.snrDb).toBeGreaterThan(30);
  });
});
