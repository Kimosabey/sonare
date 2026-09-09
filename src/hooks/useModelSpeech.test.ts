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
import { phraseTokens, useModelSpeech } from "./useModelSpeech.js";

type Voice = { lang: string; name: string };

/**
 * The utterance as the hook built it, so a test can play the engine's side.
 *
 * The stub deliberately fires nothing by itself. That is the honest default:
 * an engine that reports no word boundaries is the common case on several
 * platforms, so silence has to be what a test gets unless it asks otherwise.
 */
interface StubUtterance {
  text: string;
  lang: string;
  rate: number;
  voice: unknown;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  onboundary: ((event: { name: string; charIndex: number }) => void) | null;
}

function stubSynth(voices: Voice[]) {
  const spoken: { text: string; lang: string; voice: Voice | null; rate: number }[] = [];
  const utterances: StubUtterance[] = [];
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
      utterances.push(u as unknown as StubUtterance);
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
      onboundary: ((event: { name: string; charIndex: number }) => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    },
  });
  // No separate globalThis assignment: in jsdom `window` *is* `globalThis`, so
  // the defineProperty above already exposes the bare identifier the hook uses
  // — and jsdom defines this one read-only, so assigning it throws.
  return { spoken, utterances, cancel };
}

/** The engine reaching a character offset in the utterance it is speaking. */
function boundary(utterance: StubUtterance | undefined, charIndex: number, name = "word"): void {
  act(() => utterance?.onboundary?.({ name, charIndex }));
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

/**
 * Splitting the phrase, which both the hook and the screen do with this one
 * function so that "word 3" cannot mean two different things.
 */
describe("phraseTokens", () => {
  it("keeps every character, so the phrase can be rebuilt from the tokens", () => {
    // The screen redraws the phrase out of these. A tokenizer that dropped or
    // normalised whitespace would quietly rewrite the target text a learner is
    // being scored against — French puts a space before its question mark.
    const phrase = "Comment allez-vous ?";

    expect(phraseTokens(phrase).map((t) => t.text).join("")).toBe(phrase);
  });

  it("numbers the words and leaves the gaps unnumbered", () => {
    const tokens = phraseTokens("Bonjour, comment  ça va");

    expect(tokens.filter((t) => t.index !== null).map((t) => t.text)).toEqual([
      "Bonjour,",
      "comment",
      "ça",
      "va",
    ]);
    // Including the double space, which is one gap rather than two words.
    expect(tokens.filter((t) => t.index === null).map((t) => t.text)).toEqual([" ", "  ", " "]);
  });

  it("reports each token's offset in the phrase, matching what a boundary reports", () => {
    const tokens = phraseTokens("Guten Tag");

    expect(tokens.map((t) => t.start)).toEqual([0, 5, 6]);
  });

  it("survives leading and trailing whitespace without inventing empty words", () => {
    const tokens = phraseTokens("  Hola  ");

    expect(tokens.map((t) => t.text).join("")).toBe("  Hola  ");
    expect(tokens.filter((t) => t.index !== null)).toHaveLength(1);
  });

  it("has no words in a phrase that is only whitespace", () => {
    expect(phraseTokens("   ").filter((t) => t.index !== null)).toEqual([]);
    expect(phraseTokens("")).toEqual([]);
  });
});

/**
 * Marking the word as the voice reaches it — the thing that turns hearing a
 * phrase into following one.
 *
 * The load-bearing test in here is the one where nothing fires. `boundary`
 * support is uneven and several engines report nothing at all, so the marking
 * has to be an enhancement that a platform is free not to provide: same
 * playback, no highlight, and above all no waiting on an event that is never
 * coming. The stub fires nothing unless a test asks it to, which makes that
 * the default every other assertion here is written against.
 */
describe("the word being spoken", () => {
  it("marks nothing before the voice has reported anything", () => {
    const { result } = renderHook(() => useModelSpeech("fr-FR"));

    expect(result.current.wordIndex).toBeNull();
  });

  it("moves the mark from word to word as the voice reaches them", () => {
    const { utterances } = stubSynth([{ lang: "fr-FR", name: "Thomas" }]);

    const { result } = renderHook(() => useModelSpeech("fr-FR"));
    act(() => result.current.speak("Bonjour comment ça va", "fr-FR"));

    boundary(utterances[0], 0);
    expect(result.current.wordIndex).toBe(0);

    boundary(utterances[0], 8);
    expect(result.current.wordIndex).toBe(1);

    boundary(utterances[0], 16);
    expect(result.current.wordIndex).toBe(2);
  });

  it("marks a word from any offset inside it, not only its first letter", () => {
    // Engines disagree about which character a word "starts" at, and some
    // report a length rather than a position. An offset anywhere in the run
    // has to name the run.
    const { utterances } = stubSynth([{ lang: "de-DE", name: "Anna" }]);

    const { result } = renderHook(() => useModelSpeech("de-DE"));
    act(() => result.current.speak("Guten Tag", "de-DE"));

    boundary(utterances[0], 3);

    expect(result.current.wordIndex).toBe(0);
  });

  it("resolves an offset that lands between words forwards, to the word about to be said", () => {
    /**
     * Some engines report the whitespace before a word rather than the word.
     * Resolving backwards would leave the mark on the word that just finished
     * — a highlight one word behind the voice, which teaches exactly the
     * mapping this feature exists to teach, off by one.
     */
    const { utterances } = stubSynth([{ lang: "es-ES", name: "Mónica" }]);

    const { result } = renderHook(() => useModelSpeech("es-ES"));
    act(() => result.current.speak("Buenos días señor", "es-ES"));

    boundary(utterances[0], 6);

    expect(result.current.wordIndex).toBe(1);
  });

  it("ignores a sentence boundary, which moves no word", () => {
    const { utterances } = stubSynth([{ lang: "fr-FR", name: "Thomas" }]);

    const { result } = renderHook(() => useModelSpeech("fr-FR"));
    act(() => result.current.speak("Bonjour comment ça va", "fr-FR"));

    boundary(utterances[0], 8);
    boundary(utterances[0], 0, "sentence");

    expect(result.current.wordIndex).toBe(1);
  });

  it("keeps the last word marked when an offset runs past the phrase", () => {
    // Clearing mid-phrase would read as the voice having stopped. An offset
    // nothing can be made of is a report to drop, not one to obey.
    const { utterances } = stubSynth([{ lang: "fr-FR", name: "Thomas" }]);

    const { result } = renderHook(() => useModelSpeech("fr-FR"));
    act(() => result.current.speak("Bonjour comment", "fr-FR"));

    boundary(utterances[0], 8);
    boundary(utterances[0], 999);

    expect(result.current.wordIndex).toBe(1);
  });

  it("speaks normally and marks nothing where the engine reports no boundaries", () => {
    /**
     * The common case on several platforms, and the one that must not
     * regress: the utterance is spoken with the same text, locale, voice and
     * rate, `speaking` is true, and the mark simply never appears. Nothing
     * here is waiting on an event.
     */
    const { spoken, utterances } = stubSynth([{ lang: "fr-FR", name: "Thomas" }]);

    const { result } = renderHook(() => useModelSpeech("fr-FR"));
    act(() => result.current.speak("Bonjour comment ça va", "fr-FR"));

    expect(spoken[0]?.text).toBe("Bonjour comment ça va");
    expect(spoken[0]?.voice?.name).toBe("Thomas");
    expect(result.current.speaking).toBe(true);
    expect(result.current.wordIndex).toBeNull();

    // And it still finishes on its own, rather than waiting for a boundary
    // that is never coming.
    act(() => utterances[0]?.onend?.());

    expect(result.current.speaking).toBe(false);
    expect(result.current.wordIndex).toBeNull();
  });

  it("clears the mark when the utterance ends", () => {
    const { utterances } = stubSynth([{ lang: "fr-FR", name: "Thomas" }]);

    const { result } = renderHook(() => useModelSpeech("fr-FR"));
    act(() => result.current.speak("Bonjour comment", "fr-FR"));
    boundary(utterances[0], 0);

    act(() => utterances[0]?.onend?.());

    expect(result.current.wordIndex).toBeNull();
  });

  it("clears the mark when the utterance fails", () => {
    // A failed utterance leaving a word lit is the same lie as one leaving the
    // control looking busy.
    const { utterances } = stubSynth([{ lang: "fr-FR", name: "Thomas" }]);

    const { result } = renderHook(() => useModelSpeech("fr-FR"));
    act(() => result.current.speak("Bonjour comment", "fr-FR"));
    boundary(utterances[0], 0);

    act(() => utterances[0]?.onerror?.());

    expect(result.current.wordIndex).toBeNull();
  });

  it("clears the mark on cancel", () => {
    const { utterances } = stubSynth([{ lang: "fr-FR", name: "Thomas" }]);

    const { result } = renderHook(() => useModelSpeech("fr-FR"));
    act(() => result.current.speak("Bonjour comment", "fr-FR"));
    boundary(utterances[0], 8);

    act(() => result.current.cancel());

    expect(result.current.wordIndex).toBeNull();
  });

  it("ignores a late boundary from an utterance that has been replaced", () => {
    /**
     * A second tap replaces the first. The old utterance can still be holding
     * queued events, and obeying them would renumber the phrase now playing
     * against the offsets of the one that is over.
     */
    const { utterances } = stubSynth([{ lang: "fr-FR", name: "Thomas" }]);

    const { result } = renderHook(() => useModelSpeech("fr-FR"));
    act(() => result.current.speak("Bonjour comment ça va", "fr-FR"));
    act(() => result.current.speak("Bonjour comment ça va", "fr-FR"));

    boundary(utterances[1], 0);
    boundary(utterances[0], 16);

    expect(result.current.wordIndex).toBe(0);
  });
});
