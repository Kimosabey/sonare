// @vitest-environment jsdom

/**
 * Turning a tapped syllable into a measurement.
 *
 * Two kinds of property here, and the second is the one worth the file. The
 * first is ordinary lifecycle: a new take invalidates the old estimate. The
 * second is that **every path that does not produce a measurement produces
 * nothing at all** — never a refusal that reads to a learner as a fact about
 * how they spoke. A take that failed to decode and a vowel that was genuinely
 * unmeasurable are different things, and only one of them is about the learner.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const estimateFormants = vi.fn();

vi.mock("../speech/capture/formants.js", () => ({
  estimateFormants: (samples: Float32Array, rate: number) =>
    estimateFormants(samples, rate) as unknown,
}));

const { useVowelEstimate } = await import("./useVowelEstimate.js");

const SAMPLE_RATE = 16_000;
const TICKS_PER_SECOND = 10_000_000;

/** One second of a ramp, so a slice's contents identify where it came from. */
const CHANNEL = Float32Array.from({ length: SAMPLE_RATE }, (_, i) => i / SAMPLE_RATE);

let decodeFails = false;

function fakeBuffer(): AudioBuffer {
  return {
    duration: 1,
    length: CHANNEL.length,
    sampleRate: SAMPLE_RATE,
    numberOfChannels: 1,
    getChannelData: () => CHANNEL,
  } as unknown as AudioBuffer;
}

const MEASURED = {
  kind: "measured",
  f1Hz: 400,
  f2Hz: 2100,
  f1SpreadHz: 20,
  f2SpreadHz: 40,
  frames: 8,
  framesSeen: 10,
};

beforeEach(() => {
  decodeFails = false;
  estimateFormants.mockReturnValue(MEASURED);

  class FakeContext {
    close = vi.fn(() => Promise.resolve());
    decodeAudioData = vi.fn(() =>
      decodeFails ? Promise.reject(new Error("bad wav")) : Promise.resolve(fakeBuffer()),
    );
  }
  vi.stubGlobal("AudioContext", FakeContext);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/**
 * A Blob whose arrayBuffer() resolves, which is all the hook asks of it.
 *
 * Every `renderHook` below hoists one rather than calling this inline. A take
 * built inside the render callback is a new object on every render, and the
 * hook treats a new take as a new recording — so the estimate it had just set
 * would be cleared by its own re-render. `ActivityTest` passes
 * `recorder.lastCapture?.wav`, which is the same object until a new take
 * replaces it.
 */
function take(): Blob {
  return {
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
  } as unknown as Blob;
}

function syllable(over: Partial<{ offsetTicks: number; durationTicks: number; grapheme: string }> = {}) {
  return {
    offsetTicks: 0.25 * TICKS_PER_SECOND,
    durationTicks: 0.1 * TICKS_PER_SECOND,
    grapheme: "jour",
    ...over,
  };
}

describe("measuring a syllable", () => {
  it("reports what the estimator said, against the syllable that was tapped", async () => {
    const wav = take();
    const { result } = renderHook(() => useVowelEstimate(wav));

    act(() => result.current.measure(syllable()));

    await waitFor(() => expect(result.current.estimate).not.toBeNull());
    expect(result.current.estimate?.grapheme).toBe("jour");
    expect(result.current.estimate?.outcome).toEqual(MEASURED);
  });

  /**
   * The measurement property, and the reason this hook does not reuse
   * `useSyllablePlayback`'s slice. Playback pads by 60ms either side so a
   * clipped syllable does not sound like a glitch; padding here would pull in
   * the neighbouring consonants, whose transitions are exactly what moves F1
   * and F2. The slice is the syllable and nothing else.
   */
  it("measures exactly the syllable's span, with no padding", async () => {
    const wav = take();
    const { result } = renderHook(() => useVowelEstimate(wav));

    act(() => result.current.measure(syllable()));
    await waitFor(() => expect(estimateFormants).toHaveBeenCalled());

    const [samples, rate] = estimateFormants.mock.calls[0] as [Float32Array, number];
    expect(rate).toBe(SAMPLE_RATE);
    // 0.25s in, 0.1s long, at 16 kHz.
    expect(samples.length).toBe(0.1 * SAMPLE_RATE);
    expect(samples[0]).toBeCloseTo(0.25, 5);
  });

  it("clips a span that runs past the end of the take", async () => {
    const wav = take();
    const { result } = renderHook(() => useVowelEstimate(wav));

    act(() =>
      result.current.measure(
        syllable({ offsetTicks: 0.9 * TICKS_PER_SECOND, durationTicks: 5 * TICKS_PER_SECOND }),
      ),
    );

    await waitFor(() => expect(estimateFormants).toHaveBeenCalled());
    const [samples] = estimateFormants.mock.calls[0] as [Float32Array];
    expect(samples.length).toBeLessThanOrEqual(CHANNEL.length);
    expect(samples.length).toBeCloseTo(0.1 * SAMPLE_RATE, -1);
  });
});

describe("what it refuses to claim", () => {
  /**
   * An empty span is not a short vowel. Handing it to the estimator would come
   * back "too-short", which the chart renders as "that syllable was too short
   * to measure" — a sentence about how the learner spoke, produced by a slice
   * that never existed.
   */
  it("says nothing at all for a zero-length span", async () => {
    const wav = take();
    const { result } = renderHook(() => useVowelEstimate(wav));

    act(() => result.current.measure(syllable({ durationTicks: 0 })));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(estimateFormants).not.toHaveBeenCalled();
    expect(result.current.estimate).toBeNull();
  });

  it("says nothing when the take cannot be decoded", async () => {
    decodeFails = true;
    const wav = take();
    const { result } = renderHook(() => useVowelEstimate(wav));

    act(() => result.current.measure(syllable()));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current.estimate).toBeNull();
  });

  it("offers nothing when there is no take", () => {
    const { result } = renderHook(() => useVowelEstimate(null));

    expect(result.current.available).toBe(false);
    act(() => result.current.measure(syllable()));
    expect(estimateFormants).not.toHaveBeenCalled();
  });
});

describe("when the take changes", () => {
  /**
   * The estimate has to go with it. A chart left standing beside a new take's
   * score would be the previous attempt's vowel presented as this one's — the
   * most confidently wrong thing this screen could show.
   */
  it("drops the previous take's measurement", async () => {
    const first = take();
    const { result, rerender } = renderHook(({ wav }) => useVowelEstimate(wav), {
      initialProps: { wav: first },
    });

    act(() => result.current.measure(syllable()));
    await waitFor(() => expect(result.current.estimate).not.toBeNull());

    rerender({ wav: take() });

    expect(result.current.estimate).toBeNull();
  });

  it("clears on request, so a new activity starts with no chart", async () => {
    const wav = take();
    const { result } = renderHook(() => useVowelEstimate(wav));

    act(() => result.current.measure(syllable()));
    await waitFor(() => expect(result.current.estimate).not.toBeNull());

    act(() => result.current.clear());
    expect(result.current.estimate).toBeNull();
  });
});
