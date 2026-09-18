// @vitest-environment jsdom

/**
 * The two kinds that never open the microphone, driven through the screen.
 *
 * Every part of this was already tested, and the assembly was not.
 * `locate.ts` and `listen.ts` compose the options, `LocateOptions.test.tsx`
 * renders them, `honesty.test.ts` proves `affordancesFor` asks for no
 * microphone in any state a silent kind can be in, and `courses.test.ts`
 * proves the shipped content composes a real question. Nothing put those
 * together on the page a learner actually meets.
 *
 * That gap matters more here than it usually would, because the property
 * being protected is a **one-shot** one. On iOS a learner may only ever be
 * asked for the microphone once: a screen that reaches the recorder by some
 * route nothing on it suggests does not merely misbehave, it spends the single
 * prompt the platform allows and cannot ask again. `affordancesFor` returning
 * `needsMicrophone: false` is a fact about a function; what the screen does
 * with it is a separate fact, and this file is where it is checked.
 *
 * The recorder mock is therefore a spy rather than a stub. A stub proves the
 * screen renders; a spy proves it never asked.
 */

import { useCallback, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { RecorderState } from "../speech/capture/types.js";
import type { ActivityKind, LanguageActivitySet } from "../activities/types.js";

/**
 * A set whose first activity is the silent one, so the branch under test is
 * the first thing the screen renders and no navigation stands between the
 * test and its subject.
 *
 * The four spoken activities are not filler. `locate` derives its wrong
 * answers from syllables *other* phrases drill, so a set with nothing else in
 * it composes no question at all — the screen would honestly say so and the
 * test would pass having rendered the empty-handed branch. Their targets are
 * chosen so that none of the three distractors occurs in the locate's phrase.
 */
function setWith(kind: ActivityKind): LanguageActivitySet {
  return {
    code: "fr-FR",
    slug: "fr",
    label: "French",
    activities: [
      {
        id: 1,
        title: "Hearing it before saying it",
        kind,
        prompt: "Listen, then choose.",
        gloss: "Hello everyone.",
        target: "Bonjour tout le monde",
        focus: "Recognising the sound by ear",
        soundTargets: ["jour"],
        ...(kind === "listen" ? { distractors: ["Bonsoir tout le monde"] } : {}),
      },
      spoken(2, "Merci beaucoup", "ci"),
      spoken(3, "Quatre gares", "gare"),
      spoken(4, "Deux livres", "deux"),
      spoken(5, "Bien sûr", "bien"),
    ],
  };
}

function spoken(id: number, target: string, syllable: string) {
  return {
    id,
    title: `Activity ${String(id)}`,
    kind: "repeat" as const,
    prompt: "Say it back",
    gloss: target,
    target,
    focus: `the ${syllable} sound`,
    soundTargets: [syllable],
  };
}

let active: LanguageActivitySet = setWith("locate");

vi.mock("../content/resolve.js", () => ({
  resolveLanguage: () => active,
  resolveLanguages: () => [active],
  servedVersions: () => ({}),
}));

/**
 * Every way this screen could reach a microphone, counted.
 *
 * `start` opens the device. `warm` is the quieter one and the reason this is a
 * spy: it exists to get permission out of the way *before* the learner presses
 * record, so a screen that warms on mount would spend the prompt without ever
 * showing a record button — invisible to any check that looks at what is on
 * screen.
 */
const micCalls: string[] = [];
let endSession = vi.fn();
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
      lastCapture: null,
      granted: null,
      contextSampleRate: null,
      clipping: false,
      sessionActive: false,
      levelStore: { subscribe: () => () => undefined, getSnapshot: () => -60 },
      start: vi.fn(() => void micCalls.push("start")),
      stop: vi.fn(() => void micCalls.push("stop")),
      cancel: vi.fn(),
      warm: vi.fn(() => void micCalls.push("warm")),
      releaseDevice: vi.fn(),
      endSession,
      reset: doReset,
    };
  },
}));

vi.mock("../hooks/useCaptureToasts.js", () => ({
  useCaptureToasts: () => undefined,
  HEARD_SPEECH_SNR_DB: 10,
}));
vi.mock("../hooks/useSyllablePlayback.js", () => ({
  useSyllablePlayback: () => ({ playingOffsetTicks: null, play: vi.fn(), available: false }),
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
vi.mock("../hooks/useWakeLock.js", () => ({ useWakeLock: () => undefined }));
vi.mock("../components/ToastProvider.js", () => ({
  useToast: () => ({ push: vi.fn(), dismiss: vi.fn(), clear: vi.fn() }),
}));

function installStorage(): void {
  const data = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
      key: (i: number) => [...data.keys()][i] ?? null,
      get length() {
        return data.size;
      },
    },
  });
}

async function open() {
  const { ActivityTest } = await import("./ActivityTest.js");
  const view = render(
    <MemoryRouter initialEntries={["/fr"]}>
      <Routes>
        <Route path="/:slug" element={<ActivityTest />} />
      </Routes>
    </MemoryRouter>,
  );
  const start = screen.queryByRole("button", { name: /Start/i });
  if (start) fireEvent.click(start);
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
  micCalls.length = 0;
  endSession = vi.fn();
  scored = null;
  installStorage();
  // The result phase animates its numbers. Reduced motion is the right default
  // in jsdom, which has no frame clock — it jumps them straight to their
  // targets instead of needing one.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  active = setWith("locate");
});

afterEach(cleanup);

/**
 * The options list, found by the question it asks.
 *
 * Deliberately not "the first `<ul>` on the page": a list located by position
 * still passes when it has no accessible name, and an unnamed list is exactly
 * the defect this found in `LocateOptions`. Both kinds name themselves, so one
 * accessor serves both and a list that loses its name fails here.
 */
function options(): HTMLElement | null {
  return screen.queryByRole("list", { name: /which/i });
}

describe.each(["locate", "listen"] as const)("a %s activity, on the screen", (kind) => {
  beforeEach(() => {
    active = setWith(kind);
  });

  /**
   * The one-shot property. Not "no record button is visible" — that is what a
   * learner sees, and the prompt can be spent by a path they never see.
   */
  it("never asks the recorder for anything", async () => {
    await open();
    await waitFor(() => {
      expect(options()).not.toBeNull();
    });

    expect(micCalls).toEqual([]);
  });

  it("offers nothing to record with", async () => {
    await open();
    await waitFor(() => {
      expect(options()).not.toBeNull();
    });

    expect(screen.queryByRole("button", { name: /^Record$|^Stop$/ })).toBeNull();
    // Nor the escape hatches that exist only because recording can go wrong.
    expect(screen.queryByRole("button", { name: /quiet place|skip/i })).toBeNull();
  });

  /**
   * And choosing works. A screen that renders the question but cannot take an
   * answer is a blank task with extra steps, and it would pass both tests
   * above.
   */
  it("takes an answer and moves on", async () => {
    await open();
    await waitFor(() => {
      expect(options()).not.toBeNull();
    });
    const choices = within(options()!).getAllByRole("button");

    expect(choices.length).toBeGreaterThan(1);
    fireEvent.click(choices[0]!);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Next activity/i })).toBeInTheDocument();
    });
    expect(micCalls).toEqual([]);
  });
});

/** A passing take, so a spoken activity can be finished and advanced out of. */
function passes(): void {
  act(() =>
    scored?.(
      {
        accuracy: 95,
        overall: 95,
        fluency: 90,
        completeness: 100,
        indeterminate: false,
        words: [],
        provider: "azure",
      },
      { durationSeconds: 2, snrDb: 18, contextSampleRate: 48000, granted: {}, wav: null },
    ),
  );
}

/**
 * A set that reaches the silent kind the way the French course does — after
 * activities that do record, rather than as the first thing on screen.
 *
 * This is the case the first version of this file could not see. It only ever
 * rendered activity one, so the effect that runs on *moving between*
 * activities never fired, and removing the guard from it changed nothing any
 * test could feel. In the shipped content the silent activity is nineteenth.
 */
function setWithSilentSecond(kind: ActivityKind): LanguageActivitySet {
  return {
    code: "fr-FR",
    slug: "fr",
    label: "French",
    activities: [
      spoken(1, "Merci beaucoup", "ci"),
      {
        id: 2,
        title: "Hearing it before saying it",
        kind,
        prompt: "Listen, then choose.",
        gloss: "Hello everyone.",
        target: "Bonjour tout le monde",
        focus: "Recognising the sound by ear",
        soundTargets: ["jour"],
        ...(kind === "listen" ? { distractors: ["Bonsoir tout le monde"] } : {}),
      },
      spoken(3, "Quatre gares", "gare"),
      spoken(4, "Deux livres", "deux"),
      spoken(5, "Bien sûr", "bien"),
    ],
  };
}

describe("arriving at a silent activity from a spoken one", () => {
  it.each(["locate", "listen"] as const)(
    "does not open the microphone on the way into a %s",
    async (kind) => {
      active = setWithSilentSecond(kind);
      await open();

      // Activity one records, so it warms — that is the behaviour being kept.
      expect(micCalls).toContain("warm");

      passes();
      const next = await screen.findByRole("button", { name: /Next activity/i });
      micCalls.length = 0;
      fireEvent.click(next);

      await waitFor(() => {
        expect(options()).not.toBeNull();
      });
      expect(micCalls).toEqual([]);
    },
  );

  /**
   * Non-vacuity, and the reason it is not a formality: every assertion above
   * is satisfied by a screen that has stopped warming altogether. That would
   * be a silent NFR-01 regression — the learner's first Record tap would pay
   * the full cold getUserMedia and AudioWorklet cost, which is the thing
   * warming exists to hide behind the seconds they spend reading the prompt.
   */
  it("still warms on the way into an activity that records", async () => {
    active = setWithSilentSecond("locate");
    await open();

    passes();
    const next = await screen.findByRole("button", { name: /Next activity/i });
    fireEvent.click(next);

    // Through the locate, by answering it, and on to activity three.
    await waitFor(() => {
      expect(options()).not.toBeNull();
    });
    fireEvent.click(within(options()!).getAllByRole("button")[0]!);
    const onward = await screen.findByRole("button", { name: /Next activity/i });
    micCalls.length = 0;
    fireEvent.click(onward);

    await waitFor(() => {
      expect(micCalls).toContain("warm");
    });
  });

  /** And at the start of a session, where the first activity is a spoken one. */
  it("still warms when the session opens on an activity that records", async () => {
    active = setWithSilentSecond("locate");
    await open();

    expect(micCalls).toContain("warm");
  });
});
