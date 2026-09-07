// @vitest-environment jsdom

/**
 * Hearing yourself and the model back to back.
 *
 * The value is entirely in the *sequence*: either sound alone leaves a learner
 * comparing against their memory of a sound. So the tests are about ordering
 * and about the two ways a scheduled second half can go wrong — starting while
 * the first is still playing, and outliving the screen that asked for it.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCompareToModel } from "./useCompareToModel.js";

const TICKS_PER_SECOND = 10_000_000;

function handles(over: { playbackAvailable?: boolean; modelAvailable?: boolean } = {}) {
  const order: string[] = [];
  const playback = {
    play: vi.fn((offset: number, duration: number) => order.push(`play:${offset}:${duration}`)),
    available: over.playbackAvailable ?? true,
  };
  const model = {
    speak: vi.fn((text: string) => order.push(`speak:${text}`)),
    cancel: vi.fn(() => order.push("cancel")),
    available: over.modelAvailable ?? true,
  };
  return { playback, model, order };
}

/** A 200 ms syllable one second into the take. */
const TARGET = {
  offsetTicks: 1 * TICKS_PER_SECOND,
  durationTicks: 0.2 * TICKS_PER_SECOND,
  word: "comment",
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the sequence", () => {
  it("plays the learner first and the model after", () => {
    const { playback, model, order } = handles();
    const { result } = renderHook(() => useCompareToModel(playback, model, "fr-FR"));

    act(() => result.current.compare(TARGET));
    expect(playback.play).toHaveBeenCalledWith(TARGET.offsetTicks, TARGET.durationTicks);
    expect(model.speak).not.toHaveBeenCalled();

    act(() => void vi.advanceTimersByTime(2000));

    expect(order.filter((o) => o.startsWith("play") || o.startsWith("speak"))).toEqual([
      `play:${TARGET.offsetTicks}:${TARGET.durationTicks}`,
      "speak:comment",
    ]);
  });

  it("waits for the learner's slice to finish before speaking", () => {
    /**
     * The slice is played with 60 ms of padding either side, so a delay of
     * only the syllable's own duration would start the model while the
     * learner's voice is still sounding — two voices at once, which is the one
     * thing a comparison must not be.
     */
    const { playback, model } = handles();
    const { result } = renderHook(() => useCompareToModel(playback, model, "fr-FR"));

    act(() => result.current.compare(TARGET));

    // 200 ms of syllable is not enough: the padded slice runs 320 ms.
    act(() => void vi.advanceTimersByTime(250));
    expect(model.speak).not.toHaveBeenCalled();

    act(() => void vi.advanceTimersByTime(400));
    expect(model.speak).toHaveBeenCalledTimes(1);
  });

  it("scales the wait with the syllable's own length", () => {
    // A long syllable must not be talked over, and a short one must not leave
    // a silence long enough to look broken.
    const { playback, model } = handles();
    const { result } = renderHook(() => useCompareToModel(playback, model, "fr-FR"));

    act(() =>
      result.current.compare({ ...TARGET, durationTicks: 1.5 * TICKS_PER_SECOND }),
    );

    act(() => void vi.advanceTimersByTime(900));
    expect(model.speak).not.toHaveBeenCalled();

    act(() => void vi.advanceTimersByTime(1200));
    expect(model.speak).toHaveBeenCalledTimes(1);
  });

  it("speaks the whole word, not the syllable", () => {
    /**
     * Handing "ment" to speech synthesis produces a reading of those letters
     * with its own stress and vowel — not that syllable as it sounds inside
     * "comment". A learner would be matching themselves against an artefact,
     * which is a worse reference than none.
     */
    const { playback, model } = handles();
    const { result } = renderHook(() => useCompareToModel(playback, model, "fr-FR"));

    act(() => result.current.compare(TARGET));
    act(() => void vi.advanceTimersByTime(2000));

    expect(model.speak).toHaveBeenCalledWith("comment", "fr-FR");
  });

  it("speaks in the language being taught", () => {
    // A French word in an English voice is the one thing a pronunciation
    // reference cannot be.
    const { playback, model } = handles();
    const { result } = renderHook(() => useCompareToModel(playback, model, "hi-IN"));

    act(() => result.current.compare({ ...TARGET, word: "नमस्ते" }));
    act(() => void vi.advanceTimersByTime(2000));

    expect(model.speak).toHaveBeenCalledWith("नमस्ते", "hi-IN");
  });
});

describe("a second tap", () => {
  it("replaces the first comparison rather than queueing behind it", () => {
    /**
     * The same stance the syllable chips and the Listen button already take. A
     * queue would leave a learner listening to a comparison they had moved on
     * from, with no way to stop it.
     */
    const { playback, model } = handles();
    const { result } = renderHook(() => useCompareToModel(playback, model, "fr-FR"));

    act(() => result.current.compare(TARGET));
    act(() => void vi.advanceTimersByTime(100));
    act(() => result.current.compare({ ...TARGET, word: "allez" }));
    act(() => void vi.advanceTimersByTime(2000));

    expect(model.speak).toHaveBeenCalledTimes(1);
    expect(model.speak).toHaveBeenCalledWith("allez", "fr-FR");
  });

  it("stops any model speech already running", () => {
    // Otherwise the previous word finishes over the new comparison.
    const { playback, model } = handles();
    const { result } = renderHook(() => useCompareToModel(playback, model, "fr-FR"));

    act(() => result.current.compare(TARGET));
    act(() => void vi.advanceTimersByTime(2000));
    model.cancel.mockClear();

    act(() => result.current.compare(TARGET));

    expect(model.cancel).toHaveBeenCalled();
  });
});

describe("leaving mid-comparison", () => {
  it("does not speak after the component has gone", () => {
    /**
     * The failure with no other guard. `model.cancel()` cannot help a
     * scheduled utterance that has not started, so without clearing the timer
     * a learner who leaves an activity between the two halves hears a French
     * word spoken over whatever they opened next.
     */
    const { playback, model } = handles();
    const view = renderHook(() => useCompareToModel(playback, model, "fr-FR"));

    act(() => view.result.current.compare(TARGET));
    view.unmount();
    act(() => void vi.advanceTimersByTime(5000));

    expect(model.speak).not.toHaveBeenCalled();
  });

  it("cancels speech already in progress on unmount", () => {
    const { playback, model } = handles();
    const view = renderHook(() => useCompareToModel(playback, model, "fr-FR"));
    act(() => view.result.current.compare(TARGET));
    act(() => void vi.advanceTimersByTime(2000));
    model.cancel.mockClear();

    view.unmount();

    expect(model.cancel).toHaveBeenCalled();
  });

  it("leaves no timer behind", () => {
    const { playback, model } = handles();
    const view = renderHook(() => useCompareToModel(playback, model, "fr-FR"));
    act(() => view.result.current.compare(TARGET));

    view.unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("availability", () => {
  it("needs both halves", () => {
    /**
     * Playing only the learner back, under a label promising a comparison, is
     * worse than not offering it — and a platform with no voice for the
     * language is the ordinary case for Hindi on some devices.
     */
    const withoutModel = handles({ modelAvailable: false });
    const withoutTake = handles({ playbackAvailable: false });
    const both = handles();

    const a = renderHook(() => useCompareToModel(withoutModel.playback, withoutModel.model, "fr-FR"));
    const b = renderHook(() => useCompareToModel(withoutTake.playback, withoutTake.model, "fr-FR"));
    const c = renderHook(() => useCompareToModel(both.playback, both.model, "fr-FR"));

    expect(a.result.current.available).toBe(false);
    expect(b.result.current.available).toBe(false);
    expect(c.result.current.available).toBe(true);
  });
});
