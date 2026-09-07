// @vitest-environment jsdom

/**
 * Hearing your own syllable back, and the three ways that can go wrong
 * invisibly.
 *
 * The feature closes the second-largest gap in the product: a learner is told
 * `ment` scored 77 and otherwise has no way to hear their own `ment`. It works
 * even where the written form does not — every Hindi syllable measured is
 * timed while none are named — so this is the only feedback a Hindi learner
 * gets at syllable level.
 *
 * What needs guarding is not the happy path. It is (1) that a stale playback
 * cannot clear a newer one's highlight, which manual testing finds only by
 * tapping two chips inside 200ms; (2) that the AudioContext is created inside
 * the click and closed on unmount, because on iOS a context created outside a
 * gesture never starts and one left open keeps the hardware audio session
 * claimed and interferes with the *next capture*; and (3) that the audio is
 * never persisted anywhere — attempts.ts is explicit that storing learner
 * voice is a data-protection decision, not a build one.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSyllablePlayback } from "./useSyllablePlayback.js";

const TICKS = 10_000_000;

interface FakeSource {
  buffer: unknown;
  onended: (() => void) | null;
  connect: (dest: unknown) => void;
  start: (when: number, offset: number, duration: number) => void;
  stop: () => void;
  startArgs: [number, number, number] | null;
  stopped: boolean;
}

interface FakeContext {
  state: string;
  closed: boolean;
  sources: FakeSource[];
  decodeCalls: number;
  resumeCalls: number;
  destination: object;
  createBufferSource: () => FakeSource;
  decodeAudioData: (b: ArrayBuffer) => Promise<{ duration: number }>;
  resume: () => Promise<void>;
  close: () => Promise<void>;
}

let contexts: FakeContext[] = [];
/** Duration of the decoded take, in seconds. */
let takeDuration = 5;
let decodeShouldFail = false;

function installAudio(options: { initialState?: string } = {}): void {
  class Ctx implements FakeContext {
    state = options.initialState ?? "running";
    closed = false;
    sources: FakeSource[] = [];
    decodeCalls = 0;
    resumeCalls = 0;
    destination = {};
    constructor() {
      contexts.push(this);
    }
    createBufferSource(): FakeSource {
      const src: FakeSource = {
        buffer: null,
        onended: null,
        startArgs: null,
        stopped: false,
        connect: () => undefined,
        start: (when, offset, duration) => {
          src.startArgs = [when, offset, duration];
        },
        stop: () => {
          src.stopped = true;
        },
      };
      this.sources.push(src);
      return src;
    }
    decodeAudioData(): Promise<{ duration: number }> {
      this.decodeCalls += 1;
      if (decodeShouldFail) return Promise.reject(new Error("corrupt"));
      return Promise.resolve({ duration: takeDuration });
    }
    resume(): Promise<void> {
      this.resumeCalls += 1;
      this.state = "running";
      return Promise.resolve();
    }
    close(): Promise<void> {
      this.closed = true;
      return Promise.resolve();
    }
  }
  vi.stubGlobal("AudioContext", Ctx as unknown as typeof AudioContext);
}

/** A Blob that counts how many times its bytes were read. */
function take(): Blob & { reads: number } {
  const blob = new Blob([new Uint8Array(64)], { type: "audio/wav" }) as Blob & { reads: number };
  blob.reads = 0;
  const original = blob.arrayBuffer.bind(blob);
  blob.arrayBuffer = () => {
    blob.reads += 1;
    return original();
  };
  return blob;
}

/**
 * Renders with one stable Blob identity. Building the take inside the hook
 * callback would mint a new Blob on every render, and the `[wav]` effect —
 * which correctly treats a new take as invalidating the decoded buffer — would
 * fire on each one and reset playback. Real callers hold the take in recorder
 * state, so its identity is stable across renders.
 */
function renderWithTake(wav = take()) {
  const view = renderHook(() => useSyllablePlayback(wav));
  return { ...view, wav };
}

beforeEach(() => {
  contexts = [];
  takeDuration = 5;
  decodeShouldFail = false;
  installAudio();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("availability", () => {
  it("reports unavailable with no take, so chips stay static rather than lying", () => {
    // A tappable chip that does nothing is worse than one that is plainly not
    // tappable, because the learner concludes the feature is broken.
    const { result } = renderHook(() => useSyllablePlayback(null));

    expect(result.current.available).toBe(false);
    expect(result.current.playingOffsetTicks).toBeNull();
  });

  it("reports available once there is a take", () => {
    const { result } = renderWithTake();

    expect(result.current.available).toBe(true);
  });

  it("does nothing when asked to play with no take", () => {
    // No context should be created either — an AudioContext built for a
    // playback that cannot happen still claims the iOS audio session.
    const { result } = renderHook(() => useSyllablePlayback(null));

    act(() => result.current.play(0, TICKS));

    expect(contexts).toHaveLength(0);
  });
});

describe("the slice that gets played", () => {
  it("pads both ends, because a bare syllable registers as a click", async () => {
    /**
     * A syllable is often 150-250ms. Without its onset and release a learner
     * hears a blip and learns nothing — and the onset is the part of a
     * syllable pronunciation feedback is most often about.
     */
    const { result } = renderWithTake();

    act(() => result.current.play(1 * TICKS, 0.2 * TICKS));

    await waitFor(() => expect(contexts[0]?.sources[0]?.startArgs).not.toBeNull());
    const [, offset, duration] = contexts[0]!.sources[0]!.startArgs!;
    expect(offset).toBeCloseTo(0.94, 5); // 1.00 - 0.06
    expect(duration).toBeCloseTo(0.32, 5); // 0.20 + 2 x 0.06
  });

  it("does not seek before the start of the take", async () => {
    // The first syllable of an utterance begins near zero, so its padded start
    // is negative — which throws on a real AudioBufferSourceNode.
    const { result } = renderWithTake();

    act(() => result.current.play(0, 0.2 * TICKS));

    await waitFor(() => expect(contexts[0]?.sources[0]?.startArgs).not.toBeNull());
    expect(contexts[0]!.sources[0]!.startArgs![1]).toBe(0);
  });

  it("does not run past the end of the take", async () => {
    /**
     * The last syllable's padded end exceeds the buffer, and a duration longer
     * than what remains throws. Azure's offsets are also measured against the
     * audio it received, which is not always exactly what the buffer holds.
     */
    takeDuration = 2;
    const { result } = renderWithTake();

    act(() => result.current.play(1.9 * TICKS, 0.5 * TICKS));

    await waitFor(() => expect(contexts[0]?.sources[0]?.startArgs).not.toBeNull());
    const [, offset, duration] = contexts[0]!.sources[0]!.startArgs!;
    expect(offset + duration).toBeLessThanOrEqual(2);
  });

  it("still plays something audible for a zero-length syllable", async () => {
    // A syllable Azure timed at zero duration would otherwise be a silent tap.
    const { result } = renderWithTake();

    act(() => result.current.play(1 * TICKS, 0));

    await waitFor(() => expect(contexts[0]?.sources[0]?.startArgs).not.toBeNull());
    expect(contexts[0]!.sources[0]!.startArgs![2]).toBeGreaterThanOrEqual(0.02);
  });
});

describe("the highlight", () => {
  it("marks the syllable that is sounding", async () => {
    const { result } = renderWithTake();

    act(() => result.current.play(3 * TICKS, TICKS));

    await waitFor(() => expect(result.current.playingOffsetTicks).toBe(3 * TICKS));
  });

  it("clears when playback ends naturally", async () => {
    const { result } = renderWithTake();
    act(() => result.current.play(3 * TICKS, TICKS));
    await waitFor(() => expect(result.current.playingOffsetTicks).toBe(3 * TICKS));

    act(() => contexts[0]!.sources[0]!.onended?.());

    expect(result.current.playingOffsetTicks).toBeNull();
  });

  it("does not let a stale source clear a newer one's highlight", async () => {
    /**
     * Two chips tapped in quick succession. The first source's `onended` fires
     * *after* the second has started — so without the identity guard it would
     * clear the highlight on the syllable now playing, and the learner would
     * hear audio with nothing lit up. Findable by hand only inside a 200ms
     * window.
     */
    const { result } = renderWithTake();
    act(() => result.current.play(1 * TICKS, TICKS));
    await waitFor(() => expect(contexts[0]?.sources).toHaveLength(1));
    const first = contexts[0]!.sources[0]!;

    act(() => result.current.play(2 * TICKS, TICKS));
    await waitFor(() => expect(result.current.playingOffsetTicks).toBe(2 * TICKS));
    act(() => first.onended?.());

    expect(result.current.playingOffsetTicks).toBe(2 * TICKS);
  });

  it("stops the previous slice before starting the next", async () => {
    // Two syllables sounding at once is not feedback, it is noise.
    const { result } = renderWithTake();
    act(() => result.current.play(1 * TICKS, TICKS));
    await waitFor(() => expect(contexts[0]?.sources).toHaveLength(1));

    act(() => result.current.play(2 * TICKS, TICKS));
    await waitFor(() => expect(contexts[0]?.sources).toHaveLength(2));

    expect(contexts[0]!.sources[0]!.stopped).toBe(true);
  });
});

describe("the audio session, which iOS charges for", () => {
  it("creates no context until the first tap", () => {
    /**
     * Two reasons, both iOS. A context created at mount is created outside a
     * user gesture and never starts. And a context that exists claims the
     * hardware audio session, which then interferes with the next *capture* —
     * so mounting the report screen would degrade the next recording.
     */
    renderHook(() => useSyllablePlayback(take()));

    expect(contexts).toHaveLength(0);
  });

  it("reuses one context across taps rather than opening one per syllable", async () => {
    // Contexts are a limited resource; a learner exploring ten syllables must
    // not open ten.
    const { result } = renderWithTake();

    act(() => result.current.play(1 * TICKS, TICKS));
    await waitFor(() => expect(contexts).toHaveLength(1));
    act(() => result.current.play(2 * TICKS, TICKS));
    await waitFor(() => expect(contexts[0]?.sources).toHaveLength(2));

    expect(contexts).toHaveLength(1);
  });

  it("resumes a context the platform suspended", async () => {
    // Safari suspends on backgrounding. Without the resume, playback silently
    // does nothing and the chip looks broken.
    installAudio({ initialState: "suspended" });
    const { result } = renderWithTake();

    act(() => result.current.play(1 * TICKS, TICKS));

    await waitFor(() => expect(contexts[0]?.resumeCalls).toBe(1));
  });

  it("closes the context on unmount, releasing the hardware session", async () => {
    // Leaving the report screen must hand the audio session back before the
    // next activity opens the microphone.
    const { result, unmount } = renderWithTake();
    act(() => result.current.play(1 * TICKS, TICKS));
    await waitFor(() => expect(contexts).toHaveLength(1));

    unmount();

    expect(contexts[0]!.closed).toBe(true);
  });

  it("unmounts cleanly having never played anything", () => {
    // The commonest path by far: a learner who never taps a chip.
    const { unmount } = renderWithTake();

    expect(() => unmount()).not.toThrow();
    expect(contexts).toHaveLength(0);
  });
});

describe("decoding, and never keeping the audio", () => {
  it("decodes once and reuses the buffer for later syllables", async () => {
    // Decoding a 15-second take per chip tap would put a visible delay on
    // every syllable after the first.
    const { result } = renderWithTake();

    act(() => result.current.play(1 * TICKS, TICKS));
    await waitFor(() => expect(contexts[0]?.decodeCalls).toBe(1));
    act(() => result.current.play(2 * TICKS, TICKS));
    await waitFor(() => expect(contexts[0]?.sources).toHaveLength(2));

    expect(contexts[0]!.decodeCalls).toBe(1);
  });

  it("re-decodes when a new take replaces the old one", async () => {
    /**
     * The buffer is not merely stale after a new attempt — it is the wrong
     * audio. Playing it would show the learner a syllable from a take they
     * have already moved past, scored against a different attempt.
     */
    const first = take();
    const { result, rerender } = renderHook(({ wav }) => useSyllablePlayback(wav), {
      initialProps: { wav: first as Blob },
    });
    act(() => result.current.play(1 * TICKS, TICKS));
    await waitFor(() => expect(contexts[0]?.decodeCalls).toBe(1));

    rerender({ wav: take() });
    act(() => result.current.play(1 * TICKS, TICKS));

    await waitFor(() => expect(contexts[0]?.decodeCalls).toBe(2));
  });

  it("stops playback the moment a new take arrives", async () => {
    // Otherwise the previous attempt's audio keeps sounding over the new one's
    // score.
    const { result, rerender } = renderHook(({ wav }) => useSyllablePlayback(wav), {
      initialProps: { wav: take() as Blob },
    });
    act(() => result.current.play(1 * TICKS, TICKS));
    await waitFor(() => expect(result.current.playingOffsetTicks).toBe(1 * TICKS));

    rerender({ wav: take() });

    expect(result.current.playingOffsetTicks).toBeNull();
  });

  it("re-reads the Blob rather than reusing a detached buffer", async () => {
    /**
     * decodeAudioData detaches the ArrayBuffer it is handed, so a cached
     * ArrayBuffer would be zero-length on the second decode — silent playback
     * with no error. Asserting the Blob is read again on each decode is what
     * pins that.
     */
    const first = take();
    const { result, rerender } = renderHook(({ wav }) => useSyllablePlayback(wav), {
      initialProps: { wav: first as Blob },
    });
    act(() => result.current.play(1 * TICKS, TICKS));
    await waitFor(() => expect(first.reads).toBeGreaterThanOrEqual(1));

    const second = take();
    rerender({ wav: second });
    act(() => result.current.play(1 * TICKS, TICKS));

    await waitFor(() => expect(second.reads).toBeGreaterThanOrEqual(1));
  });

  it("never writes the take to browser storage", () => {
    /**
     * The data-protection guarantee, asserted rather than asserted-in-a-
     * comment. attempts.ts is explicit that storing learner voice recordings
     * is a decision for a person, not a convenience for a feature — so no
     * localStorage, no sessionStorage, no object URL that outlives the
     * component.
     */
    // Storage is installed explicitly rather than spied on Storage.prototype:
    // jsdom here exposes localStorage as a bare object, so a prototype spy
    // would never be on the path and the assertion would pass vacuously.
    const setItem = vi.fn();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: { getItem: () => null, setItem, removeItem: () => undefined, clear: () => undefined },
    });
    const createObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL });

    const { result, unmount } = renderWithTake();
    act(() => result.current.play(1 * TICKS, TICKS));
    unmount();

    expect(setItem).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});

describe("when playback cannot happen", () => {
  it("swallows a decode failure rather than surfacing an error over a real score", async () => {
    /**
     * Playback is an aid; the score is the product. A corrupt buffer or a
     * denied audio session must not replace a learner's legitimate result with
     * an error message about a convenience feature.
     */
    decodeShouldFail = true;
    const { result } = renderWithTake();

    act(() => result.current.play(1 * TICKS, TICKS));

    await waitFor(() => expect(contexts[0]?.decodeCalls).toBe(1));
    expect(result.current.playingOffsetTicks).toBeNull();
  });

  it("survives a platform with no AudioContext at all", () => {
    // Older WebViews. The chips should simply not sound.
    vi.stubGlobal("AudioContext", undefined);
    const { result } = renderWithTake();

    expect(() => act(() => result.current.play(1 * TICKS, TICKS))).not.toThrow();
  });
});
