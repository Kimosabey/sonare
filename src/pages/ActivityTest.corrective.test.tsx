// @vitest-environment jsdom

/**
 * Tapping a syllable — board 1e, "tap a syllable to hear yourself, then the
 * model".
 *
 * Both halves of this have existed for a long time and only ever met in one
 * place: a "Hear yours, then mine" button beside the weakest syllable.
 * Everywhere else a tap played the learner back and stopped, which is the half
 * that cannot teach anything — hearing your own vowel again tells you what you
 * did, not what to aim at.
 *
 * So what is asserted is the join: a tap reaches the comparison, carrying the
 * word the syllable came from, and falls back to playing the take alone when
 * there is no voice for the language rather than doing nothing at all.
 */

import { useCallback, useState } from "react";
import { cleanup, fireEvent, render, screen, within, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { RecorderState } from "../speech/capture/types.js";
import type { LanguageActivitySet } from "../activities/types.js";

const ACTIVITY_SET: LanguageActivitySet = {
  code: "fr-FR",
  slug: "fr",
  label: "French",
  activities: [
    {
      id: 1,
      title: "Greeting",
      kind: "repeat",
      prompt: "Say hello",
      gloss: "Hello",
      target: "Bonjour madame",
      focus: "the French r",
      soundTargets: ["bon"],
    },
  ],
};

vi.mock("../content/resolve.js", async () => {
  const actual = await vi.importActual<typeof import("../content/resolve.js")>(
    "../content/resolve.js",
  );
  return { ...actual, resolveLanguage: () => ACTIVITY_SET, resolveLanguages: () => [ACTIVITY_SET] };
});

/* ── the two halves of the comparison, under the test's control ─────────── */

const playSlice = vi.fn();
let playbackAvailable = true;
vi.mock("../hooks/useSyllablePlayback.js", () => ({
  useSyllablePlayback: () => ({
    playingOffsetTicks: null,
    play: playSlice,
    available: playbackAvailable,
  }),
}));

const compareSpy = vi.fn();
let compareAvailable = true;
vi.mock("../hooks/useCompareToModel.js", () => ({
  useCompareToModel: () => ({ compare: compareSpy, available: compareAvailable }),
}));

vi.mock("../hooks/useModelSpeech.js", async () => {
  const actual = await vi.importActual<typeof import("../hooks/useModelSpeech.js")>(
    "../hooks/useModelSpeech.js",
  );
  return {
    phraseTokens: actual.phraseTokens,
    useModelSpeech: () => ({
      speak: vi.fn(),
      cancel: vi.fn(),
      speaking: false,
      available: true,
      wordIndex: null,
    }),
  };
});

let scored: ((result: unknown, capture: unknown) => void) | null = null;
vi.mock("../speech/react/useRecorder.js", () => ({
  useRecorder: (options: { onScored: (r: unknown, c: unknown) => void }) => {
    const [state, setState] = useState<RecorderState>("idle");
    const [result, setResult] = useState<unknown>(null);
    scored = (r, c) => {
      setResult(r);
      options.onScored(r, c);
      setState("idle");
    };
    const doReset = useCallback(() => {
      setResult(null);
      setState("idle");
    }, []);
    return {
      state,
      speaking: false,
      level: -60,
      result,
      error: null,
      lastCapture: { wav: new Blob(), snrDb: 20 },
      granted: null,
      contextSampleRate: null,
      clipping: false,
      sessionActive: false,
      levelStore: { subscribe: () => () => undefined, getSnapshot: () => -60 },
      start: vi.fn(),
      stop: vi.fn(),
      cancel: vi.fn(),
      warm: vi.fn(),
      releaseDevice: vi.fn(),
      endSession: vi.fn(),
      reset: doReset,
    };
  },
}));

vi.mock("../hooks/useCaptureToasts.js", () => ({
  useCaptureToasts: () => undefined,
  HEARD_SPEECH_SNR_DB: 10,
}));
vi.mock("../hooks/useWakeLock.js", () => ({ useWakeLock: () => undefined }));
vi.mock("../components/ToastProvider.js", () => ({
  useToast: () => ({ push: vi.fn(), dismiss: vi.fn(), clear: vi.fn() }),
}));
vi.mock("../hooks/useMicEnvironment.js", () => ({
  useMicEnvironment: () => ({
    availability: { state: "available" },
    inputCount: 1,
    inputs: [{ deviceId: "default", label: "Built-in" }],
    origin: "https://example.test",
    recheck: vi.fn(),
  }),
}));

/** A take whose second word carries the syllable the test taps. */
function take(): void {
  act(() =>
    scored?.(
      {
        accuracy: 62,
        overall: 62,
        fluency: 90,
        completeness: 100,
        indeterminate: false,
        provider: "azure",
        recognized: "Bonjour madame",
        words: [
          {
            word: "Bonjour",
            accuracy: 80,
            errorType: "None",
            phonemes: [],
            syllables: [
              { grapheme: "bon", accuracy: 80, offsetTicks: 100, durationTicks: 50 },
              { grapheme: "jour", accuracy: 62, offsetTicks: 150, durationTicks: 50 },
            ],
          },
          {
            word: "madame",
            accuracy: 44,
            errorType: "Mispronunciation",
            phonemes: [],
            syllables: [
              { grapheme: "ma", accuracy: 44, offsetTicks: 200, durationTicks: 40 },
              { grapheme: "dame", accuracy: 50, offsetTicks: 240, durationTicks: 40 },
            ],
          },
        ],
      },
      { durationSeconds: 2, snrDb: 20, contextSampleRate: 48000, granted: {}, wav: new Blob() },
    ),
  );
}

beforeEach(() => {
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return map.size;
      },
      clear: () => map.clear(),
      getItem: (k: string) => map.get(k) ?? null,
      key: (i: number) => [...map.keys()][i] ?? null,
      removeItem: (k: string) => void map.delete(k),
      setItem: (k: string, v: string) => void map.set(k, v),
    },
  });
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
  playSlice.mockClear();
  compareSpy.mockClear();
  playbackAvailable = true;
  compareAvailable = true;
});

afterEach(cleanup);

async function open() {
  const { ActivityTest } = await import("./ActivityTest.js");
  render(
    <MemoryRouter initialEntries={["/fr"]}>
      <Routes>
        <Route path="/:slug" element={<ActivityTest />} />
      </Routes>
    </MemoryRouter>,
  );
  const start = screen.queryByRole("button", { name: /Start|Continue/i });
  if (start) fireEvent.click(start);
}

/**
 * Opens a word chip and taps one of its syllables.
 *
 * By text, then up to the enclosing button. The chips put their text in inner
 * spans, so querying by accessible name finds nothing — and a prefix match on
 * "ma" would find the word "madame" as well as the syllable. `getByText` with
 * a string is exact, which is what tells the two apart.
 */
function tapSyllable(word: string, syllable: string): void {
  const wordChip = screen.getByText(word).closest("button");
  if (wordChip === null) throw new Error(`no chip for the word “${word}”`);
  fireEvent.click(wordChip);

  /**
   * Scoped to the opened detail panel. The advice line above the card also
   * names the weakest syllable — «Weakest sound: "ma" in "madame"» — so an
   * unscoped query finds two.
   */
  const panel = document.getElementById("phoneme-detail");
  if (panel === null) throw new Error("the word chip did not open its detail");

  /**
   * `getAllByText`, because a chip carries the grapheme twice: once visibly and
   * `aria-hidden`, once as the accessible name. Both sit inside the same
   * button, so either will do — the first is taken rather than asserting on
   * how the chip labels itself, which is that component's own business.
   */
  const sylChip = within(panel).getAllByText(syllable)[0]?.closest("button");
  if (sylChip === undefined || sylChip === null) {
    throw new Error(`no chip for the syllable “${syllable}”`);
  }
  fireEvent.click(sylChip);
}

describe("tapping a syllable", () => {
  it("plays the learner, then the model saying the word it came from", async () => {
    await open();
    take();

    tapSyllable("madame", "ma");

    expect(compareSpy).toHaveBeenCalledTimes(1);
    expect(compareSpy.mock.calls[0]?.[0]).toMatchObject({
      offsetTicks: 200,
      durationTicks: 40,
      word: "madame",
    });
  });

  /**
   * The word is found from the result rather than threaded down through three
   * components. This is what proves the lookup picks the right one: the tapped
   * syllable belongs to the *second* word, and its offset is what identifies
   * it.
   */
  it("carries the word the syllable actually belongs to, not the first one", async () => {
    await open();
    take();

    tapSyllable("Bonjour", "jour");

    expect(compareSpy.mock.calls[0]?.[0]).toMatchObject({ offsetTicks: 150, word: "Bonjour" });
  });

  /**
   * No voice for the language is the ordinary case for some devices, and a tap
   * that did nothing would read as a broken chip. The take alone is worse than
   * the comparison and much better than silence.
   */
  it("falls back to the take alone when there is no model voice", async () => {
    compareAvailable = false;
    await open();
    take();

    tapSyllable("madame", "ma");

    expect(compareSpy).not.toHaveBeenCalled();
    expect(playSlice).toHaveBeenCalledWith(200, 40);
  });

  it("offers no tap at all when the take cannot be played back", async () => {
    playbackAvailable = false;
    await open();
    take();

    const chip = screen.getByText("madame").closest("button");
    if (chip === null) throw new Error("no chip for madame");
    fireEvent.click(chip);

    /**
     * The detail still opens — the breakdown is worth reading whether or not
     * it can be played. What is absent is the *tap*: with no take to play,
     * `SyllableChips` renders spans rather than buttons, so there is nothing
     * offering an interaction that could not happen.
     */
    const panel = document.getElementById("phoneme-detail");
    expect(panel).not.toBeNull();
    expect(panel?.querySelectorAll("button.sy")).toHaveLength(0);
  });

  it("tells the learner what a tap will do", async () => {
    await open();
    take();
    const chip = screen.getByText("madame").closest("button");
    if (chip === null) throw new Error("no chip for madame");
    fireEvent.click(chip);

    expect(screen.getByText(/hear yourself, then the model/i)).toBeInTheDocument();
  });
});
