// @vitest-environment jsdom

/**
 * Voice selection and availability are the parts worth pinning: a wrong-locale
 * voice teaches the wrong accent, which is the exact variable this product
 * measures, and a control offered with no voice behind it is a lie.
 *
 * jsdom implements no speech synthesis at all, so the API is stubbed. That is
 * also the honest test of the unavailable path.
 */

import { act } from "react";
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useModelSpeech } from "./useModelSpeech.js";

type Voice = { lang: string; name: string };

function stubSynth(voices: Voice[]) {
  const spoken: { text: string; lang: string; voice: Voice | null; rate: number }[] = [];
  const cancel = vi.fn();
  const synth = {
    getVoices: () => voices as unknown as SpeechSynthesisVoice[],
    speak: (u: SpeechSynthesisUtterance) => {
      spoken.push({
        text: u.text,
        lang: u.lang,
        voice: (u.voice as unknown as Voice | null) ?? null,
        rate: u.rate,
      });
    },
    cancel,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  Object.defineProperty(window, "speechSynthesis", { configurable: true, value: synth });
  // jsdom has no constructor for this either.
  Object.defineProperty(window, "SpeechSynthesisUtterance", {
    configurable: true,
    value: class {
      text: string;
      lang = "";
      rate = 1;
      voice: unknown = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    },
  });
  // No separate globalThis assignment: in jsdom `window` *is* `globalThis`, so
  // the defineProperty above already exposes the bare identifier the hook uses
  // — and jsdom defines this one read-only, so assigning it throws.
  return { spoken, cancel };
}

afterEach(() => {
  delete (window as { speechSynthesis?: unknown }).speechSynthesis;
  vi.restoreAllMocks();
});

describe("useModelSpeech", () => {
  it("is unavailable when the platform has no voice for the language", () => {
    // Offering a Listen button that produces silence is worse than not
    // offering one — the learner concludes the app is broken.
    stubSynth([{ lang: "en-US", name: "Alex" }]);

    const { result } = renderHook(() => useModelSpeech("hi-IN"));

    expect(result.current.available).toBe(false);
  });

  it("is available when a matching voice exists", () => {
    stubSynth([{ lang: "fr-FR", name: "Thomas" }]);

    const { result } = renderHook(() => useModelSpeech("fr-FR"));

    expect(result.current.available).toBe(true);
  });

  it("prefers an exact locale match over the same base language", () => {
    // fr-CA reading a fr-FR phrase is a different accent, which is precisely
    // the variable this product exists to measure.
    const { spoken } = stubSynth([
      { lang: "fr-CA", name: "Amélie" },
      { lang: "fr-FR", name: "Thomas" },
    ]);

    const { result } = renderHook(() => useModelSpeech("fr-FR"));
    act(() => result.current.speak("Bonjour", "fr-FR"));

    expect(spoken[0]?.voice?.name).toBe("Thomas");
  });

  it("falls back to the base language rather than going silent", () => {
    const { spoken } = stubSynth([{ lang: "es-MX", name: "Paulina" }]);

    const { result } = renderHook(() => useModelSpeech("es-ES"));
    expect(result.current.available).toBe(true);

    act(() => result.current.speak("Buenos días", "es-ES"));
    expect(spoken[0]?.voice?.name).toBe("Paulina");
  });

  it("speaks under natural pace, so syllable boundaries are audible", () => {
    const { spoken } = stubSynth([{ lang: "de-DE", name: "Anna" }]);

    const { result } = renderHook(() => useModelSpeech("de-DE"));
    act(() => result.current.speak("Guten Tag", "de-DE"));

    expect(spoken[0]?.rate).toBeLessThan(1);
    // Not so slow that the vowels being copied are distorted.
    expect(spoken[0]?.rate).toBeGreaterThan(0.7);
  });

  it("cancels before speaking, so a second tap replaces rather than queues", () => {
    const { cancel } = stubSynth([{ lang: "fr-FR", name: "Thomas" }]);

    const { result } = renderHook(() => useModelSpeech("fr-FR"));
    act(() => result.current.speak("Bonjour", "fr-FR"));
    act(() => result.current.speak("Bonjour", "fr-FR"));

    // Hearing the phrase twice over itself is worse than not hearing it.
    expect(cancel).toHaveBeenCalled();
  });

  it("ignores an empty phrase", () => {
    const { spoken } = stubSynth([{ lang: "fr-FR", name: "Thomas" }]);

    const { result } = renderHook(() => useModelSpeech("fr-FR"));
    act(() => result.current.speak("   ", "fr-FR"));

    expect(spoken).toHaveLength(0);
  });

  it("cancels on unmount, so speech does not carry into the next screen", () => {
    const { cancel } = stubSynth([{ lang: "fr-FR", name: "Thomas" }]);

    const { result, unmount } = renderHook(() => useModelSpeech("fr-FR"));
    act(() => result.current.speak("Bonjour", "fr-FR"));
    cancel.mockClear();

    unmount();

    expect(cancel).toHaveBeenCalled();
  });
});
