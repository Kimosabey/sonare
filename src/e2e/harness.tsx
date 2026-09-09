/**
 * The shared rig for the whole-app suites in this directory.
 *
 * Every other client test mounts one page in isolation. These mount the real
 * `App` — its HashRouter, its `Shell`, its `useSync`, its lazy routes — and
 * walk a learner across screens, because the properties they are about only
 * exist between screens: a name typed on the picker greeting the learner on
 * Today, a take on the activity screen moving the streak, a syllable measured
 * in one session appearing on Progress a navigation later.
 *
 * Three things this rig has to get right, and they are the three things that
 * bite a whole-app jsdom test:
 *
 * **Storage.** jsdom hands out a `localStorage` that is a bare object with no
 * methods, so the first `getItem` on a real journey throws inside a store's
 * `try` and every screen quietly renders as a learner with no history — a
 * green test asserting nothing. `installStorage` puts a real in-memory
 * `Storage` in its place, seeded per test.
 *
 * **The recorder.** How a score is obtained belongs to `recorder.test.ts`;
 * what the app does with one is these files' subject. `makeRecorderStub`
 * builds the same *stateful* stub `ActivityTest.test.tsx` uses — a landed
 * score leaves a `result` on the hook and drops the state back to `idle`,
 * exactly as `useRecorder` does — because a stub pinned to
 * `{ state: "idle", result: null }` describes a state the real recorder can
 * never be in, and the activity screen sequences what it shows off precisely
 * those two fields.
 *
 * **The network.** `Shell` mounts `useSync` and `useContentSync` with no
 * injected fetch, so both reach for the global. A journey that leaves it alone
 * either hits the real network or throws; `installFetch` makes it explicit and
 * countable.
 *
 * Nothing here mocks a page, a store, a router or a rule. The point of these
 * suites is that the real ones are wired together.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RenderResult } from "@testing-library/react";
import { useCallback, useState } from "react";
import { expect, vi } from "vitest";
import type { PronunciationResult, ScoredSyllable } from "../speech/scoring/types.js";
import type { RecorderState } from "../speech/capture/types.js";

/* ── storage ──────────────────────────────────────────────────────────────── */

/**
 * A real `Storage` over a `Map`, installed on `window`.
 *
 * Returns the backing map so a test can read what the app persisted without
 * going through the app — which is the only way to observe the things no
 * screen renders, such as the dirty flags or a `skipped` activity.
 */
export function installStorage(seed?: Record<string, string>): Map<string, string> {
  const data = new Map(Object.entries(seed ?? {}));
  const storage: Storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, String(value)),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  return data;
}

/** The learner-name key, so a seed does not restate the string. */
export const LEARNER_NAME_KEY = "sonare.learnerName";

/* ── browser globals jsdom does not provide ───────────────────────────────── */

/**
 * The globals a whole-app render touches and jsdom does not implement.
 *
 * `matchMedia` answers "reduced motion" on purpose: the report's count-up
 * reads it, and the reduced-motion branch jumps every figure straight to its
 * target instead of needing a frame clock.
 *
 * `crypto` is deliberately *not* stubbed. `src/lib/uuid.ts` already falls back
 * from `randomUUID` to `getRandomValues` to `Math.random`, because
 * `randomUUID` is secure-context-only and absent on the plain-HTTP LAN origin
 * the README sends you to for on-device testing. Stubbing it here would hide
 * whichever rung these journeys actually land on.
 */
export function installBrowserGlobals(options: { online?: boolean } = {}): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }));
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: options.online ?? true,
  });
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  });
  // Object URLs: the report and the export both hand over a file this way.
  vi.stubGlobal("URL", Object.assign(URL, {
    createObjectURL: () => "blob:journey",
    revokeObjectURL: () => undefined,
  }));
}

/* ── the network ──────────────────────────────────────────────────────────── */

export interface FetchLog {
  /** Every call, in order, as `METHOD url`. */
  calls: string[];
  /** Calls whose URL contains `fragment`. */
  to: (fragment: string) => string[];
  /** The mock itself, for a test that wants to change its behaviour mid-run. */
  mock: ReturnType<typeof vi.fn>;
}

/**
 * Installs the global `fetch` and records what was asked of it.
 *
 * `respond` returns the body for one request, or throws to simulate a
 * connection that is not there. Rejecting is the default because it is the
 * honest baseline for a journey: nothing in this product waits on the
 * network, so a suite that does not care about sync should still be running
 * against a network that is not answering.
 */
export function installFetch(
  respond: (url: string, init?: RequestInit) => unknown = () => {
    throw new TypeError("Failed to fetch");
  },
): FetchLog {
  const calls: string[] = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const body = respond(url, init);
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", mock);
  return {
    calls,
    to: (fragment: string) => calls.filter((call) => call.includes(fragment)),
    mock,
  };
}

/* ── the recorder ─────────────────────────────────────────────────────────── */

/** A capture as the screen reads it — SNR drives "heard speech", the rest is metadata. */
export interface StubCapture {
  durationSeconds: number;
  snrDb: number;
  contextSampleRate: number;
  granted: Record<string, unknown>;
  wav: null;
}

export interface RecorderErrorStub {
  code: string;
  domain: string;
  userMessage: string;
  detail: string;
}

export interface RecorderDriver {
  /** Publishes a scored result, exactly as `useRecorder` does. */
  score: (result: PronunciationResult, capture?: Partial<StubCapture>) => void;
  /** Moves the lifecycle, optionally with an error. */
  enter: (state: RecorderState, error?: RecorderErrorStub | null) => void;
  /** Forgets the last take, as `reset()` does. */
  clear: () => void;
  /** Calls to `endSession`, which the screen makes when a session finishes. */
  endSession: ReturnType<typeof vi.fn>;
}

/**
 * The stateful recorder stub and a handle to drive it.
 *
 * Returned as a pair so the `vi.mock` factory in each file — which is hoisted
 * above every import and cannot close over a value created later — gets the
 * hook, while the test body gets the driver.
 */
export function makeRecorderStub(): {
  useRecorder: (options: { onScored: (result: PronunciationResult, capture: unknown) => void }) => unknown;
  driver: RecorderDriver;
} {
  let score: RecorderDriver["score"] | null = null;
  let enter: RecorderDriver["enter"] | null = null;
  let clear: RecorderDriver["clear"] | null = null;
  const endSession = vi.fn();

  const useRecorder = (options: {
    onScored: (result: PronunciationResult, capture: unknown) => void;
  }) => {
    const [state, setState] = useState<RecorderState>("idle");
    const [error, setError] = useState<RecorderErrorStub | null>(null);
    const [result, setResult] = useState<PronunciationResult | null>(null);
    const [capture, setCapture] = useState<StubCapture | null>(null);

    score = (next, overrides) => {
      const full: StubCapture = {
        durationSeconds: 2.4,
        snrDb: 18,
        contextSampleRate: 48_000,
        granted: {},
        wav: null,
        ...overrides,
      };
      setResult(next);
      setCapture(full);
      options.onScored(next, full);
      // The real hook publishes a score and returns to idle on the same tick.
      setState("idle");
    };
    enter = (next, nextError = null) => {
      setState(next);
      setError(nextError);
    };

    // Stable identities: several effects on the activity screen list a
    // recorder callback as a dependency, and a fresh function per render
    // would re-run them every time the level store ticks.
    const reset = useCallback(() => {
      setResult(null);
      setCapture(null);
      setError(null);
      setState("idle");
    }, []);
    clear = reset;

    return {
      state,
      speaking: false,
      level: -60,
      utteranceCount: 0,
      result,
      error,
      lastCapture: capture,
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
      endSession,
      reset,
    };
  };

  const driver: RecorderDriver = {
    score: (result, capture) => {
      if (score === null) throw new Error("no activity screen is mounted");
      const publish = score;
      act(() => publish(result, capture));
    },
    enter: (state, error = null) => {
      if (enter === null) throw new Error("no activity screen is mounted");
      const move = enter;
      act(() => move(state, error));
    },
    clear: () => {
      if (clear === null) throw new Error("no activity screen is mounted");
      const reset = clear;
      act(() => reset());
    },
    endSession,
  };

  return { useRecorder, driver };
}

/* ── results ──────────────────────────────────────────────────────────────── */

/**
 * A take the system declined to judge (R8).
 *
 * Carries no number at all, which is the shape of the rule rather than a
 * convention: there is no accuracy field to read, so nothing downstream can
 * accidentally treat it as a zero.
 */
export function indeterminate(reason = "no speech found to assess"): PronunciationResult {
  return { indeterminate: true, reason, provider: "azure" };
}

/**
 * A measured take.
 *
 * `syllables` matter more than they look: the persisted sound history is keyed
 * by grapheme and `weakestSkills` needs two samples of one before it will
 * report on it, so a journey that wants a trend on Today or a row on Progress
 * has to say the same syllable twice — over one take or two.
 */
export function scored(
  accuracy: number,
  words: Array<{ word: string; syllables: Array<[string, number]>; errorType?: string }> = [
    { word: "bonjour", syllables: [["bon", 70], ["jour", 55]] },
  ],
): PronunciationResult {
  let offset = 0;
  return {
    indeterminate: false,
    provider: "azure",
    recognized: words.map((w) => w.word).join(" "),
    overall: accuracy,
    accuracy,
    fluency: 90,
    completeness: 100,
    words: words.map((w) => ({
      word: w.word,
      accuracy,
      errorType: w.errorType ?? "None",
      phonemes: [],
      syllables: w.syllables.map(([grapheme, syllableAccuracy]): ScoredSyllable => {
        const syllable = {
          grapheme,
          accuracy: syllableAccuracy,
          offsetTicks: offset,
          durationTicks: 2_000_000,
        };
        offset += 2_500_000;
        return syllable;
      }),
    })),
  };
}

/* ── the app ──────────────────────────────────────────────────────────────── */

/**
 * Mounts the real `App` at a hash, wrapped exactly as `main.tsx` wraps it.
 *
 * `ToastProvider` is part of the rig rather than an extra: the activity screen
 * calls `useToast` unconditionally and throws without a provider, and the
 * toasts it pushes on advancing are themselves a thing worth asserting.
 * `ErrorBoundary` is deliberately *not* included — it would swallow a render
 * crash into a friendly message and turn a broken journey into a passing one.
 *
 * Both halves are imported *here* rather than at the top of the file, and that
 * is load-bearing: these suites call `vi.resetModules()` between tests to
 * clear the module-level identity and token caches, so a statically imported
 * `ToastProvider` would come from the previous registry while the `App` under
 * test imports a fresh one — two different React contexts, and every screen
 * throwing "useToast must be used inside <ToastProvider>".
 */
export async function renderApp(hash = "#/"): Promise<RenderResult> {
  window.location.hash = hash;
  const [{ App }, { ToastProvider }] = await Promise.all([
    import("../App.js"),
    import("../components/ToastProvider.js"),
  ]);
  return render(
    <ToastProvider>
      <App />
    </ToastProvider>,
  );
}

/**
 * Navigates the way a learner cannot: by typing a URL.
 *
 * `popstate`, not `hashchange`: the router's hash history listens for exactly
 * one event (`PopStateEventType` in react-router's history), and jsdom does
 * not raise it for a scripted hash assignment the way a browser does for a
 * user-typed one.
 *
 * Used only for `/:slug/progress`, which has no link to it anywhere in the
 * product (see the note in journey.test.tsx). Everything else in these suites
 * is reached by clicking what is on screen, because a route reachable only by
 * a test is a route a learner cannot reach either.
 */
export async function visit(hash: string): Promise<void> {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

/** The `<h1>` the shell renders for the current screen. */
export function screenHeading(): string {
  return screen.getByRole("heading", { level: 1 }).textContent ?? "";
}

/** Clicks whatever carries this accessible name, failing loudly if it is absent. */
export function press(name: RegExp | string): void {
  fireEvent.click(screen.getByRole("button", { name }));
}

/** Follows a link by its accessible name. */
export function follow(name: RegExp | string): void {
  fireEvent.click(screen.getByRole("link", { name }));
}

/**
 * Fills a labelled field.
 *
 * `fireEvent.change` rather than assigning `.value` and dispatching an event
 * by hand: React tracks the last value it wrote on the DOM node, so a direct
 * assignment makes the change look like something React already knows about
 * and the `onChange` never fires. Testing Library goes through the native
 * value setter, which is what makes a controlled input notice.
 */
export function fill(label: RegExp | string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Picks an option in a labelled `<select>`. */
export function choose(label: RegExp | string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Waits until the shell's heading is the one expected, so a step cannot race. */
export async function onScreen(heading: RegExp | string): Promise<void> {
  await waitFor(() => expect(screenHeading()).toMatch(heading));
}

/** The record button, whatever it currently calls itself. */
export function recordButton(): HTMLElement {
  return screen.getByRole("button", {
    name: /Start speaking|Try again|Start session|Stop recording|Listening/,
  });
}

/**
 * A whole take, made the way a learner makes one.
 *
 * The gesture matters and is easy to skip. Publishing a score straight into
 * the recorder stub tests the screen's handling of a result while leaving the
 * *route to it* — a record button that a condition somewhere has disabled —
 * entirely unexercised, so a change that locked the button out for an offline
 * learner would pass a suite that only ever pushed scores in from the side.
 * So the button is asserted enabled and clicked, and the lifecycle is walked
 * through the states the real hook publishes.
 */
export function speak(driver: RecorderDriver, result: PronunciationResult): void {
  const button = recordButton();
  expect(button).toBeEnabled();
  fireEvent.click(button);
  driver.enter("requesting");
  driver.enter("recording");
  driver.enter("processing");
  driver.score(result);
}
