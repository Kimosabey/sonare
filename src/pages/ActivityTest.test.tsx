// @vitest-environment jsdom

/**
 * The learner's screen, and where R8 stops being a principle and becomes
 * arithmetic.
 *
 * An indeterminate attempt must not burn a try. The learner was never
 * measured, so charging them for it would be punishing our own failure — and
 * with a 9.4% indeterminate rate on real takes, that is not a rare path. It is
 * roughly one take in eleven, so an off-by-one here would push learners past
 * activities they never actually attempted.
 *
 * The gate is deliberately soft: passing advances immediately, and exhausting
 * three *scored* tries advances anyway with the activity recorded as skipped.
 * That combination is what the tests below pin — a hard gate would trap a
 * learner on a sound they cannot yet make, and a gate that counted
 * indeterminates would do it while pretending they had three chances.
 *
 * The recorder is stubbed: how a score is obtained is recorder.test.ts's
 * subject, and what the screen *does* with one is this file's.
 */

import { useCallback, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { LANGUAGES, MAX_ATTEMPTS, PASS_SCORE } from "../activities/languages/index.js";
import type { RecorderState } from "../speech/capture/types.js";
// Not mocked, deliberately: the streak in the header has to be the store's own
// answer, and seeding through `writeStreak` proves the screen reads it rather
// than counting the takes in front of it.
import { localDay, writeStreak } from "../stores/streakStore.js";

/**
 * A helper rather than a bare index plus a throw: module-scope narrowing does
 * not survive into a closure, so `LANGUAGES[0]` stayed possibly-undefined
 * inside every test body under noUncheckedIndexedAccess.
 */
function firstLanguage(): (typeof LANGUAGES)[number] {
  const language = LANGUAGES[0];
  if (!language) throw new Error("no languages are configured");
  return language;
}

const LANGUAGE = firstLanguage();

let scored: ((result: unknown, capture: unknown) => void) | null = null;
let lifecycle: ((state: RecorderState, error?: RecorderError | null) => void) | null = null;
const reset = vi.fn();
const endSession = vi.fn();

interface RecorderError {
  code: string;
  domain: string;
  userMessage: string;
  detail: string;
}

/**
 * A *stateful* recorder stub, in the two ways the old one was not.
 *
 * It returned `result: null` forever, which is a state the real recorder
 * cannot be in: useRecorder sets `result`, calls `onScored`, and drops back to
 * `idle` on three consecutive lines from the same score, so a landed score
 * always leaves a result on the hook. Every test below therefore drove the
 * screen through "a take was scored and the recorder is holding nothing" —
 * fiction, and load-bearing fiction now that the screen sequences what it
 * shows off exactly that field.
 *
 * And its `state` was pinned to "idle", so two thirds of the lifecycle the
 * screen now reads were unreachable. `lifecycle()` drives it, which is what
 * lets the tests below assert that the phrase survives the microphone opening
 * and that the level meter does not exist before it.
 */
vi.mock("../speech/react/useRecorder.js", () => ({
  useRecorder: (options: { onScored: (r: unknown, c: unknown) => void }) => {
    const [state, setState] = useState<RecorderState>("idle");
    const [error, setError] = useState<RecorderError | null>(null);
    const [result, setResult] = useState<unknown>(null);
    const [capture, setCapture] = useState<unknown>(null);
    scored = (r, c) => {
      setResult(r);
      setCapture(c);
      options.onScored(r, c);
      // The real hook returns to idle on the same tick it publishes a score.
      setState("idle");
    };
    lifecycle = (next, nextError = null) => {
      setState(next);
      setError(nextError);
    };
    // Stable identity: several effects on the screen list a recorder callback
    // as a dependency, and a fresh function each render would re-run them.
    const doReset = useCallback(() => {
      reset();
      setResult(null);
      setCapture(null);
      setError(null);
      setState("idle");
    }, []);
    return {
      state,
      speaking: false,
      level: -60,
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
/**
 * The model voice, with availability under the test's control.
 *
 * `available` is false by default — that is the honest default for jsdom,
 * which has no speech synthesis, and it is also the case for Hindi on a real
 * device with no hi-IN voice installed. The tests that are about the control
 * itself turn it on.
 */
const modelSpeak = vi.fn();
const modelCancel = vi.fn();
let modelAvailable = false;
vi.mock("../hooks/useModelSpeech.js", () => ({
  useModelSpeech: () => ({
    speak: modelSpeak,
    cancel: modelCancel,
    speaking: false,
    available: modelAvailable,
  }),
}));
vi.mock("../hooks/useWakeLock.js", () => ({ useWakeLock: () => undefined }));
vi.mock("../components/ToastProvider.js", () => ({
  useToast: () => ({ push: vi.fn(), dismiss: vi.fn(), clear: vi.fn() }),
}));

function installStorage(seed?: Record<string, string>): Map<string, string> {
  const data = new Map(Object.entries(seed ?? {}));
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
  return data;
}

async function open() {
  const { ActivityTest } = await import("./ActivityTest.js");
  const view = render(
    <MemoryRouter initialEntries={[`/${LANGUAGE.slug}`]}>
      <Routes>
        <Route path="/:slug" element={<ActivityTest />} />
      </Routes>
    </MemoryRouter>,
  );
  // The session has to be started before any activity renders.
  const start = screen.queryByRole("button", { name: /Start/i });
  if (start) fireEvent.click(start);
  return view;
}

/** A scored take at `accuracy`, or an indeterminate one when null. */
function take(accuracy: number | null): void {
  const result =
    accuracy === null
      ? { indeterminate: true, reason: "no speech found to assess", words: [], provider: "azure" }
      : {
          accuracy,
          overall: accuracy,
          fluency: 90,
          completeness: 100,
          indeterminate: false,
          words: [],
          provider: "azure",
        };
  act(() =>
    scored?.(result, {
      durationSeconds: 2,
      snrDb: 18,
      contextSampleRate: 48000,
      granted: {},
      wav: null,
    }),
  );
}

/** Puts the recorder into one lifecycle state, with an optional error. */
function enter(state: RecorderState, error: RecorderError | null = null): void {
  act(() => lifecycle?.(state, error));
}

/**
 * The tries-remaining line as rendered.
 *
 * Was "Attempt N of M", alongside a stated "pass at 60". Both were cut: a
 * published threshold turns practice into a number to clear, and an attempt
 * *counter* reads as an exam where the same information framed as what is
 * left reads as a constraint. Every assertion below moved to the new phrasing
 * — the property each one protects is unchanged.
 */
function attemptLine(): string {
  return document.body.textContent?.match(/\d+ tries left|Last try for this one/)?.[0] ?? "";
}

/**
 * The persisted progress, which is the only way to observe the `skipped` flag.
 *
 * Worth reaching for, because the try-allowance rule is computed *twice* in
 * this file from the same premise: once for `canAdvance`, which decides
 * whether the button appears, and once for `skipped`, which is what the report
 * says the learner did. Mutation-testing found that asserting only the button
 * leaves the second free to drift — an activity could read "skipped" in the
 * report while the screen had never offered a way past it.
 */
function persistedProgress(data: Map<string, string>): {
  progress: { activityId: number; skipped: boolean; passed: boolean; attempts: unknown[] }[];
} {
  const key = [...data.keys()].find((k) => k.startsWith("sonare.progress."));
  return JSON.parse(data.get(key ?? "") ?? '{"progress":[]}') as never;
}

function nextButton(): HTMLElement | null {
  return screen.queryByRole("button", { name: /Next activity|Finish and see report/i });
}

/** Passes and advances through every activity, ending on the report. */
async function completeSession(): Promise<void> {
  for (let i = 0; i < LANGUAGE.activities.length; i++) {
    take(88);
    // Sequential on purpose: each advance has to land before the next take.
    await waitFor(() => expect(nextButton()).not.toBeNull());
    fireEvent.click(nextButton()!);
  }
}

beforeEach(() => {
  scored = null;
  lifecycle = null;
  modelAvailable = false;
  modelSpeak.mockClear();
  modelCancel.mockClear();
  reset.mockClear();
  endSession.mockClear();
  installStorage({ "sonare.learnerName": "Marie" });
  vi.stubGlobal("crypto", { randomUUID: () => "11111111-1111-4111-8111-111111111111" });
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (Macintosh)" });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  // The report's count-up animation reads the motion preference; jsdom has no
  // matchMedia. Reduced motion is the right default here — it jumps the
  // numbers straight to their targets rather than needing a frame clock.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("R8 — an indeterminate take does not cost a try", () => {
  it("leaves the attempt counter where it was", async () => {
    /**
     * The arithmetic R8 turns into. The learner was never measured, so
     * charging them a try is punishing our own failure — and at a 9.4%
     * indeterminate rate this is roughly one take in eleven, not an edge.
     */
    await open();
    const before = attemptLine();

    take(null);

    // Waits on the line itself rather than on the word "Attempt", which no
     // longer exists. Still fails if a try was burned: the text would change.
     await waitFor(() => expect(attemptLine()).toBe(before));
  });

  it("does not unlock the next activity, however many times it happens", async () => {
    /**
     * The failure this prevents: three unscoreable takes would otherwise
     * exhaust the allowance and advance a learner past an activity they never
     * actually attempted — recorded as skipped, in a report they will read.
     */
    await open();

    take(null);
    take(null);
    take(null);
    take(null);

    await waitFor(() => expect(attemptLine()).toBe("3 tries left"));
    expect(nextButton()).toBeNull();
  });

  it("does not record the activity as skipped in the report either", async () => {
    /**
     * The other half of the same rule, and the half a learner actually reads.
     * `skipped` is computed separately from `canAdvance`, so the button
     * staying hidden does not prove the report is right — an activity could be
     * filed as skipped while the screen never offered a way past it.
     */
    const data = installStorage({ "sonare.learnerName": "Marie" });
    await open();

    take(null);
    take(null);
    take(null);

    await waitFor(() => expect(persistedProgress(data).progress.length).toBeGreaterThan(0));
    const entry = persistedProgress(data).progress[0];
    expect(entry?.skipped).toBe(false);
    expect(entry?.passed).toBe(false);
  });

  it("still records the takes, so the failure rate stays measurable", async () => {
    /**
     * Not charged is not the same as not happened. The 9.4% indeterminate rate
     * is a finding about the scorer, and dropping these attempts entirely
     * would erase the evidence for it from the report.
     */
    const data = installStorage({ "sonare.learnerName": "Marie" });
    await open();

    take(null);
    take(null);

    await waitFor(() => expect(persistedProgress(data).progress.length).toBeGreaterThan(0));
    expect(persistedProgress(data).progress[0]?.attempts).toHaveLength(2);
  });

  it("still counts the scored tries around it", async () => {
    // Mixed sequence, which is the realistic one: the indeterminate ones are
    // free and the scored ones are not.
    await open();

    take(null);
    take(10);
    take(null);
    take(12);

    await waitFor(() => expect(attemptLine()).toBe("Last try for this one"));
  });
});

describe("the soft gate", () => {
  it("advances immediately on a pass", async () => {
    // Passing on the first try must not require using up the other two.
    await open();

    take(PASS_SCORE);

    await waitFor(() => expect(nextButton()).not.toBeNull());
  });

  it("treats the pass mark as passing, not as just short of it", async () => {
    // A learner reading "pass at 60" who scores exactly 60 must advance.
    await open();

    take(PASS_SCORE);

    await waitFor(() => expect(nextButton()).not.toBeNull());
  });

  it("does not advance one point below the mark", async () => {
    await open();

    take(PASS_SCORE - 1);

    await waitFor(() => expect(attemptLine()).toBe("2 tries left"));
    expect(nextButton()).toBeNull();
  });

  it("advances after three scored tries even without a pass", async () => {
    /**
     * Deliberately soft. A hard gate would trap a learner on a sound they
     * cannot yet make, with no way past it — which ends the session rather
     * than the activity.
     */
    await open();

    for (let i = 0; i < MAX_ATTEMPTS; i++) take(20);

    await waitFor(() => expect(nextButton()).not.toBeNull());
  });

  it("records that activity as not passed rather than silently letting it go", async () => {
    // The report is the deliverable. An activity nobody passed has to read
    // that way, or the report overstates the session.
    await open();

    for (let i = 0; i < MAX_ATTEMPTS; i++) take(20);

    await waitFor(() => expect(nextButton()).not.toBeNull());
    expect(document.body.textContent).toMatch(/attempts used|not passed/i);
  });

  it("keeps the best score, not the last one", async () => {
    /**
     * A learner who scores 88 then 40 has demonstrated they can say it. Taking
     * the last attempt would punish them for trying again, which is the exact
     * behaviour the three tries are meant to encourage.
     */
    await open();

    take(88);
    take(40);

    await waitFor(() => expect(nextButton()).not.toBeNull());
  });
});

describe("progress across a refresh", () => {
  it("saves the session as it goes", async () => {
    /**
     * Ten activities at three tries each is a long sitting; losing it to an
     * accidental refresh is a real cost now this is the shipped product rather
     * than only a fixture tool.
     */
    const data = installStorage({ "sonare.learnerName": "Marie" });
    await open();

    take(88);

    await waitFor(() =>
      expect([...data.keys()].some((k) => k.startsWith("sonare.progress."))).toBe(true),
    );
  });

  it("keys the save by learner and language", async () => {
    // A shared device runs several speakers, and a learner can switch
    // language mid-session — neither may inherit the other's progress.
    const data = installStorage({ "sonare.learnerName": "Marie" });
    await open();
    take(88);

    await waitFor(() => expect(data.size).toBeGreaterThan(1));
    const key = [...data.keys()].find((k) => k.startsWith("sonare.progress."));
    expect(key).toContain(LANGUAGE.slug);
    expect(key).toContain("Marie");
  });

  it("writes under a versioned key, so a shape change orphans old data", async () => {
    /**
     * This has bitten already: a saved session predated `syllables` becoming
     * required and crashed report.ts on "word.syllables is not iterable" the
     * moment it was reopened. The version in the key is what makes a future
     * bump a fresh start rather than a white screen.
     */
    const data = installStorage({ "sonare.learnerName": "Marie" });
    await open();
    take(88);

    await waitFor(() => expect(data.size).toBeGreaterThan(1));
    expect([...data.keys()].find((k) => k.startsWith("sonare.progress."))).toMatch(
      /^sonare\.progress\.v\d+\./,
    );
  });
});

describe("ending the session", () => {
  it("releases the microphone when the session finishes", async () => {
    /**
     * A recording indicator still lit while a learner reads their report
     * reads as the app listening after it has finished with them — and it is
     * the kind of thing that gets a product uninstalled rather than reported.
     */
    await open();

    await completeSession();

    await waitFor(() => expect(endSession).toHaveBeenCalled());
  });

  it("shows the report once every activity is done", async () => {
    await open();

    await completeSession();

    await waitFor(() => expect(screen.getByText(/By activity/i)).toBeInTheDocument());
  });

  it("clears the recorder between activities", async () => {
    // Otherwise the previous activity's score card is briefly on screen under
    // the next activity's prompt, attributed to a phrase never spoken.
    await open();
    take(88);

    const next = nextButton();
    if (next) fireEvent.click(next);

    expect(reset).toHaveBeenCalled();
  });
});

describe("the bar is enforced without being published", () => {
  it("never prints the pass threshold", async () => {
    /**
     * This used to assert the opposite — that the screen states "pass at 60"
     * — on the reasoning that a stated bar must match the measured one. The
     * reasoning was sound and the conclusion was wrong: the honest fix for
     * "which of these four numbers is the exam" is to stop publishing a
     * number a learner cannot act on, not to publish it more clearly.
     *
     * Asserted as an absence so the cut cannot quietly regress. That the gate
     * passes *at* the mark rather than above it is covered directly in
     * learning/session.test.ts, which is a better place for it than a
     * rendered screen.
     */
    await open();

    expect(document.body.textContent).not.toContain(`pass at ${PASS_SCORE}`);
    expect(document.body.textContent).not.toMatch(/pass(es)? at \d+/i);
  });

  it("states what is left rather than counting what is spent", async () => {
    // Same information, and it reads as a constraint rather than a rubric.
    await open();

    expect(attemptLine()).toBe(`${MAX_ATTEMPTS} tries left`);
  });
});

/**
 * Where the learner is in the session.
 *
 * Ten activities at three tries each is a long sitting, and the bar is the
 * only thing on screen that answers "how much of this is left". It was built
 * and never tested, so every state it can show was free to drift: a segment
 * stuck on "upcoming" after a pass, or a fill that counts attempted rather
 * than passed, would both still render a plausible-looking bar.
 */
describe("mid-session progress", () => {
  function segments(): string[] {
    return [...document.querySelectorAll(".step")].map((n) => n.className.replace("step step-", ""));
  }

  it("shows one segment per activity, whatever the language", async () => {
    // Not a hardcoded ten. Each language ships its own set, and a bar that
    // assumed a count would misreport the moment one changed.
    await open();

    expect(segments()).toHaveLength(LANGUAGE.activities.length);
  });

  it("marks where the learner is now", async () => {
    await open();

    expect(segments()[0]).toBe("current");
    expect(segments().slice(1).every((s) => s === "upcoming")).toBe(true);
  });

  it("marks a passed activity as passed and moves the marker on", async () => {
    await open();

    take(88);
    await waitFor(() => expect(nextButton()).not.toBeNull());
    fireEvent.click(nextButton()!);

    await waitFor(() => expect(segments()[1]).toBe("current"));
    expect(segments()[0]).toBe("passed");
  });

  it("distinguishes an activity that was attempted and not passed", async () => {
    /**
     * The state that matters most to a learner scanning the bar: "I have been
     * here and it did not go well" is different information from "I have not
     * reached this yet", and the report will show it as not passed. A bar that
     * collapsed the two would make the session look further along than it is.
     */
    await open();

    for (let i = 0; i < MAX_ATTEMPTS; i++) take(20);
    await waitFor(() => expect(nextButton()).not.toBeNull());
    fireEvent.click(nextButton()!);

    await waitFor(() => expect(segments()[1]).toBe("current"));
    expect(segments()[0]).toBe("skipped");
  });

  it("marks an exhausted activity skipped rather than passed", async () => {
    /**
     * "3 passed · 3 attempted" and "0 passed · 3 attempted" are different
     * sessions and only the first is progress — which is what the counts this
     * used to read were for. Those counts were cut as scorekeeping vocabulary
     * redundant with the rail directly below them, so the assertion moved to
     * the rail, which is the thing now carrying the distinction. It says the
     * same thing without a number and without judgement.
     */
    await open();

    for (let i = 0; i < MAX_ATTEMPTS; i++) take(20);
    await waitFor(() => expect(nextButton()).not.toBeNull());
    fireEvent.click(nextButton()!);

    await waitFor(() => expect(screen.getByLabelText("Activity 1: skipped")).toBeInTheDocument());
    expect(screen.queryByLabelText("Activity 1: passed")).not.toBeInTheDocument();
  });

  it("fills the track from passes, not from position", async () => {
    /**
     * A fill driven by how far along the learner is would show progress for
     * walking through activities without passing any of them — which is
     * exactly what the three-try soft gate allows.
     */
    await open();
    const fill = () => (document.querySelector(".steps-fill") as HTMLElement | null)?.style.width ?? "";

    expect(fill()).toBe("0%");

    take(88);
    await waitFor(() => expect(nextButton()).not.toBeNull());
    fireEvent.click(nextButton()!);

    await waitFor(() => expect(fill()).not.toBe("0%"));
    expect(Number.parseFloat(fill())).toBeCloseTo(100 / LANGUAGE.activities.length, 1);
  });

  it("names each segment for a screen reader, and hides the decorative track", async () => {
    /**
     * The bar is the session's shape. Read aloud it has to name the activity
     * and its state per segment — while the fill track carries the same
     * information again in a form a reader cannot use, so it is hidden rather
     * than announced twice.
     */
    await open();

    const first = document.querySelector(".step");
    expect(first?.getAttribute("aria-label")).toBe("Activity 1: current");
    expect(document.querySelector(".steps-track")?.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelector(".steps")?.getAttribute("role")).toBe("list");
  });

  it("survives a restored session that is already partway through", async () => {
    // Progress persists, so the bar's first render is often not from zero.
    const data = installStorage({ "sonare.learnerName": "Marie" });
    await open();
    take(88);
    await waitFor(() => expect(nextButton()).not.toBeNull());
    fireEvent.click(nextButton()!);
    await waitFor(() => expect(data.size).toBeGreaterThan(1));

    cleanup();
    // A resumed session greets the learner with "Welcome back" and its own
    // button, so the shared open() helper's /Start/i does not reach the
    // activity — matched on either label here.
    await open();
    const resume = screen.queryByRole("button", { name: /Start|Continue|Resume/i });
    if (resume) fireEvent.click(resume);

    await waitFor(() => expect(segments()[0]).toBe("passed"));
    expect(segments()[1]).toBe("current");
  });
});

/**
 * Letting a learner past an activity they cannot speak into.
 *
 * The only ways past were to pass or to spend three tries failing, so someone
 * on a bus had to record in a place they should not — which is also where the
 * 9.4% indeterminate rate comes from — or abandon the session. Neither is a
 * failure of pronunciation and neither should be recorded as one.
 */
describe("the no-audio exit", () => {
  const exitButton = () => screen.queryByRole("button", { name: /Can’t speak right now/i });

  it("is offered before anything has been recorded", async () => {
    await open();

    expect(exitButton()).not.toBeNull();
  });

  it("moves to the next activity without recording a take", async () => {
    await open();

    fireEvent.click(exitButton()!);

    await waitFor(() => expect(attemptLine()).toBe("3 tries left"));
    expect(document.body.textContent).toContain(`${LANGUAGE.activities[1]?.title ?? ""}`);
  });

  it("records it as attempted-nothing rather than as a failure", async () => {
    /**
     * Zero attempts plus `skipped` — a shape the persisted type already
     * expresses unambiguously, so no schema bump was needed. Widening
     * ActivityProgress would have orphaned every session in progress for a
     * distinction it could already carry.
     */
    const data = installStorage({ "sonare.learnerName": "Marie" });
    await open();

    fireEvent.click(exitButton()!);

    await waitFor(() => expect(persistedProgress(data).progress.length).toBeGreaterThan(0));
    const entry = persistedProgress(data).progress[0];
    expect(entry?.attempts).toHaveLength(0);
    expect(entry?.skipped).toBe(true);
    expect(entry?.passed).toBe(false);
  });

  it("marks the segment as skipped, not as still upcoming", async () => {
    // The bar has to agree with the report about what happened.
    await open();

    fireEvent.click(exitButton()!);

    await waitFor(() =>
      expect([...document.querySelectorAll(".step")][0]?.className).toContain("skipped"),
    );
  });

  it("disappears once there is a real result to act on", async () => {
    /**
     * After a take, "Next activity" is the honest way on. A second escape
     * beside it would let a learner discard a score they had just earned by
     * mis-tapping.
     */
    await open();

    take(88);

    await waitFor(() => expect(nextButton()).not.toBeNull());
    expect(exitButton()).toBeNull();
  });

  it("is not offered on an indeterminate take either", async () => {
    // An indeterminate attempt does not burn a try, so the learner still has
    // all three — but they have now recorded something, and the retry is the
    // thing to offer.
    await open();

    take(null);

    await waitFor(() => expect(attemptLine()).toBe("3 tries left"));
    expect(exitButton()).toBeNull();
  });

  it("finishes the session when used on the last activity", async () => {
    // The exit must not become a way to get stuck on the final activity.
    await open();
    for (let i = 0; i < LANGUAGE.activities.length - 1; i++) {
      take(88);
      await waitFor(() => expect(nextButton()).not.toBeNull());
      fireEvent.click(nextButton()!);
    }

    fireEvent.click(exitButton()!);

    await waitFor(() => expect(screen.getByText(/By activity/i)).toBeInTheDocument());
  });

  it("does not double-record if tapped twice", async () => {
    // Guarded on the activity already having an entry, so a fast second tap
    // cannot add a duplicate row to the report.
    const data = installStorage({ "sonare.learnerName": "Marie" });
    await open();

    fireEvent.click(exitButton()!);
    await waitFor(() => expect(persistedProgress(data).progress.length).toBe(1));

    expect(persistedProgress(data).progress).toHaveLength(1);
  });
});

describe("celebration, and the take it must never fire on", () => {
  /**
   * The motion spec's hardest rule, and it had no test.
   *
   * Confetti over an unmeasured result is a fabricated verdict wearing an
   * animation: it tells a learner they succeeded at something the system
   * explicitly declined to judge. R8 makes `indeterminate` the honest answer
   * for unusable audio, and the celebration has to respect that or the
   * honesty is only in the number and not on the screen.
   */

  it("says nothing celebratory about an indeterminate take", async () => {
    await open();

    take(null);

    expect(screen.queryByText("PASSED")).not.toBeInTheDocument();
    expect(screen.queryByText("FIRST TRY!")).not.toBeInTheDocument();
    expect(screen.queryByText("NEW BEST!")).not.toBeInTheDocument();
  });

  it("does not celebrate an indeterminate take that follows a pass", async () => {
    // The nastier version: the activity is already passed, so the banner is on
    // screen. A later unmeasurable take must not be dressed as a new success.
    await open();
    take(88);
    expect(screen.getByText("FIRST TRY!")).toBeInTheDocument();

    take(null);

    expect(screen.queryByText("FIRST TRY!")).not.toBeInTheDocument();
    expect(screen.queryByText("NEW BEST!")).not.toBeInTheDocument();
    // The pass itself stands — it was real, and R8 says the unusable take
    // costs the learner nothing.
    expect(screen.getByText("PASSED")).toBeInTheDocument();
  });

  it("does not celebrate a take below the pass mark", async () => {
    await open();

    take(40);

    expect(screen.queryByText(/FIRST TRY!|NEW BEST!|PASSED/)).not.toBeInTheDocument();
  });

  it("celebrates a first-try pass as exactly that", async () => {
    await open();

    take(88);

    expect(screen.getByText("FIRST TRY!")).toBeInTheDocument();
  });

  it("calls a beaten best a new best, and only when it is one", async () => {
    await open();
    take(65);
    take(90);

    expect(screen.getByText("NEW BEST!")).toBeInTheDocument();
  });

  it("does not claim a new best for a pass that did not beat one", async () => {
    // Otherwise every subsequent pass is a personal best, which makes the
    // label mean nothing.
    await open();
    take(90);
    take(70);

    expect(screen.queryByText("NEW BEST!")).not.toBeInTheDocument();
    expect(screen.getByText("PASSED")).toBeInTheDocument();
  });

  it("adds the celebration class only for a genuine milestone", async () => {
    /**
     * The class is what drives the pop animation. A plain pass keeps the
     * banner still, so the motion marks something that actually happened
     * rather than firing on every take that clears sixty.
     */
    const { container } = await open();
    take(90);
    expect(container.querySelector(".pass-banner-celebrate")).not.toBeNull();

    take(70);

    expect(container.querySelector(".pass-banner")).not.toBeNull();
    expect(container.querySelector(".pass-banner-celebrate")).toBeNull();
  });

  it("never animates a banner for an indeterminate take", async () => {
    await open();

    take(null);

    expect(document.querySelector(".pass-banner-celebrate")).toBeNull();
  });
});

/**
 * One state at a time.
 *
 * The screen used to render all three of its regions at once: the phrase, a
 * record region, and a result region that announced its own emptiness ("Result
 * / No attempt yet.") to a learner who had not yet spoken. Three regions
 * because the component holds three kinds of state, not because anyone needs
 * three things at once — which is most of why this read as an instrument
 * rather than a product.
 *
 * Which one shows is derived from the recorder on every render. Nothing here
 * asserts an internal name; each test drives one of the recorder's real
 * lifecycle states and asserts what a learner can see in it, so the derivation
 * stays free to change shape as long as the sequence holds.
 */
describe("the three states are sequenced, not stacked", () => {
  const phrase = () => document.querySelector(".phrase");
  const scoreCard = () => document.querySelector(".overall");
  const meter = () => document.querySelector(".meter");
  const liveRegion = () => document.querySelector("[aria-live='polite']");

  it("shows the phrase and no result before anything has been recorded", async () => {
    await open();

    expect(phrase()?.textContent).toContain(LANGUAGE.activities[0]?.target ?? "");
    expect(scoreCard()).toBeNull();
    expect(document.body.textContent).not.toMatch(/no attempt yet/i);
  });

  it("does not idle a level meter at a learner who has not spoken", async () => {
    /**
     * A meter reading silence is an instrument with nothing to measure. It was
     * the clearest single tell that this screen was built to be watched by
     * whoever wrote it rather than used by a learner.
     */
    await open();

    expect(meter()).toBeNull();
  });

  it("keeps the aria-live container mounted while it is empty", async () => {
    /**
     * The one thing here that must not be conditionally rendered, and the
     * failure is silent: a screen reader only announces changes inside a live
     * region that was *already* in the document when they happened. Mount the
     * container together with its first content and the announcement never
     * fires — no error, no visual difference, and nothing a sighted test would
     * notice.
     */
    await open();

    const region = liveRegion();
    expect(region).not.toBeNull();
    expect(region?.textContent).toBe("");
  });

  it("brings the meter up once the microphone is open, and keeps the phrase", async () => {
    /**
     * The phrase cannot vanish when recording starts. With auto-stop the
     * learner is still reading it as they speak, so removing it would take the
     * target away at the one moment it is being used.
     */
    await open();

    enter("recording");

    expect(meter()).not.toBeNull();
    expect(phrase()?.textContent).toContain(LANGUAGE.activities[0]?.target ?? "");
  });

  it("hands the screen over to the outcome while the provider is thinking", async () => {
    // The take is over by "processing", so this belongs with the result rather
    // than with the phrase — the skeleton holding the score card's shape is
    // the honest thing on screen for that second and a half.
    await open();

    enter("processing");

    expect(screen.getByTestId("score-skeleton")).toBeInTheDocument();
    expect(phrase()).toBeNull();
  });

  it("replaces the phrase with the result once there is one", async () => {
    // Not both at once: the score, the advice and the ways on are what a
    // learner needs after speaking, and the phrase is what they needed before.
    await open();

    take(40);

    await waitFor(() => expect(scoreCard()).not.toBeNull());
    expect(phrase()).toBeNull();
  });

  it("announces the result inside the container that was already there", async () => {
    // The pairing that makes the mounted-while-empty rule worth having: the
    // same node, still there, now with something in it.
    await open();
    const before = liveRegion();

    take(40);

    await waitFor(() => expect(liveRegion()?.textContent).not.toBe(""));
    expect(liveRegion()).toBe(before);
  });

  it("goes back to the phrase for the next activity", async () => {
    // advance() resets the recorder, so the derivation returns to the prompt
    // state on its own — there is no second copy of "where are we" to move.
    await open();
    take(88);
    await waitFor(() => expect(nextButton()).not.toBeNull());

    fireEvent.click(nextButton()!);

    await waitFor(() =>
      expect(phrase()?.textContent).toContain(LANGUAGE.activities[1]?.target ?? ""),
    );
    expect(scoreCard()).toBeNull();
  });

  it("treats a capture failure as an outcome, not as a missing one", async () => {
    /**
     * A learner whose microphone was refused has had something happen to
     * them. Leaving the screen in its "read this and speak" state would show
     * them a phrase and a button that has already failed, with the reason
     * somewhere below it.
     */
    await open();

    enter("error", {
      code: "NOT_ALLOWED",
      domain: "capture",
      userMessage: "Sonare needs your microphone.",
      detail: "NotAllowedError",
    });

    expect(screen.getByText("Sonare needs your microphone.")).toBeInTheDocument();
    expect(phrase()).toBeNull();
  });

  it("withdraws the no-audio exit the moment a take is in flight", async () => {
    /**
     * The exit belongs to the prompt state only. Sequencing must not have
     * quietly left it beside a live microphone, where tapping it would throw
     * away the take the learner is in the middle of.
     */
    await open();
    const exitButton = () => screen.queryByRole("button", { name: /Can’t speak right now/i });
    expect(exitButton()).not.toBeNull();

    enter("recording");

    expect(exitButton()).toBeNull();
  });
});

/**
 * The phrase is the product.
 *
 * It was one element among nine, at 22px, with the English instruction above
 * it in bold and the English translation directly below it — so the two things
 * competing hardest with the thing being taught were both English. The model
 * voice, the one control that says what the phrase is *supposed* to sound
 * like, was a small outlined afterthought under the target.
 *
 * Size is a stylesheet fact and jsdom does not apply the stylesheet, so these
 * pin what a test can actually vouch for and what a reordering would break:
 * that the phrase is its own element carrying nothing but the target and its
 * language, that the model voice is a peer of the record button and reached
 * first, and that the gloss is kept but out of the way.
 */
describe("the phrase and the model voice", () => {
  const phrase = () => document.querySelector(".phrase");
  const task = () => document.querySelector(".task");
  const gloss = () => document.querySelector(".gloss");
  const listen = () => screen.queryByRole("button", { name: /^Listen$|^Stop$/ });
  const record = () => screen.queryByRole("button", { name: /Start speaking|Listening|Stop recording/i });
  const actions = () => record()?.closest(".row") ?? null;

  /** True when `a` comes before `b` in the document. */
  function precedes(a: Element | null, b: Element | null): boolean {
    if (a === null || b === null) return false;
    return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  it("gives the target phrase an element of its own, holding only the phrase", async () => {
    // Nothing English mixed into the same line: a learner's eye has one place
    // to land, and a screen reader has one node to speak in one voice.
    await open();

    expect(phrase()?.textContent).toBe(LANGUAGE.activities[0]?.target ?? "");
  });

  it("tags the phrase with the language being taught, and nothing else", async () => {
    /**
     * WCAG 3.1.2, and the one place it is not a formality: without the tag a
     * screen reader pronounces a French phrase with English phonetics, in a
     * product whose entire subject is how that phrase should sound. The task
     * and the gloss are English *about* the phrase — tagging those would make
     * a reader speak English in a French voice, which is the same bug pointed
     * the other way.
     */
    await open();

    expect(phrase()?.getAttribute("lang")).toBe(LANGUAGE.code);
    expect(task()?.hasAttribute("lang")).toBe(false);
    expect(gloss()?.hasAttribute("lang")).toBe(false);
  });

  it("puts the model voice in the same row as the record button, and first", async () => {
    /**
     * Hearing the phrase is the first half of practising it. As a small
     * outlined control under the target it was something a learner had to
     * decide to go looking for; as a peer in the action row it is part of the
     * same gesture, in the order the two are used.
     */
    modelAvailable = true;
    await open();

    expect(listen()).not.toBeNull();
    expect(listen()?.closest(".row")).toBe(actions());
    expect(precedes(listen(), record())).toBe(true);
  });

  it("speaks the target in the target language when it is used", async () => {
    // The phrase and its locale, not the English prompt — this is the model
    // pronunciation, so passing the wrong one would demonstrate the wrong
    // sound with full confidence.
    modelAvailable = true;
    await open();

    fireEvent.click(listen()!);

    expect(modelSpeak).toHaveBeenCalledWith(LANGUAGE.activities[0]?.target, LANGUAGE.code);
  });

  it("disables the model voice while the microphone is open rather than removing it", async () => {
    /**
     * Removing it would shift the action row at the exact moment the learner
     * is about to speak. Disabling is also the safe half of the pair: a phrase
     * still sounding through the speaker while the mic is live gets captured
     * into the take and scored as if the learner had said it.
     */
    modelAvailable = true;
    await open();

    enter("recording");

    expect(listen()).toBeDisabled();
  });

  it("offers no model-voice button at all where there is no voice", async () => {
    // Hindi on a device with no hi-IN voice. A button that silently does
    // nothing is worse than no button.
    await open();

    expect(listen()).toBeNull();
  });

  it("keeps the English gloss, below the actions", async () => {
    /**
     * Kept, because nobody should practise a sentence they cannot translate.
     * Moved, because directly under the target it was the answer sitting next
     * to the question — the first thing the eye reached after the phrase was
     * the English.
     */
    await open();

    expect(gloss()?.textContent).toContain(LANGUAGE.activities[0]?.gloss ?? "");
    expect(precedes(phrase(), actions())).toBe(true);
    expect(precedes(actions(), gloss())).toBe(true);
  });
});

/**
 * The header, and the pair of choices after a result.
 *
 * Three things the screen already had and was not using. The activity has a
 * name — "Ordering in a café" — which appeared only as the tail of "Activity 3
 * of 10 — Ordering in a café", after the two thirds a learner cannot act on.
 * The streak was recorded on every take and shown nowhere until the report,
 * which is the least useful moment for a reason to keep going. And retrying
 * was the record button in a region above the score, so "have another go" and
 * "carry on" lived in different places with the nearer one discarding what the
 * learner had just read.
 */
describe("the header, and the two ways on", () => {
  const heading = () => screen.getByRole("heading");
  const chip = () => document.querySelector(".streak-chip");
  const retryButton = () => screen.queryByRole("button", { name: "Try again" });

  /** Seeds `days` consecutive practice days ending today, via the store's own API. */
  function seedStreak(days: number): void {
    const list: string[] = [];
    const day = new Date();
    for (let i = 0; i < days; i += 1) {
      list.unshift(localDay(day));
      // Calendar arithmetic rather than subtracting 86,400,000 milliseconds,
      // which lands on the same local day twice across a DST boundary.
      day.setDate(day.getDate() - 1);
    }
    writeStreak("Marie", { days: list, current: 0, longest: 0 });
  }

  it("uses the activity's own name as the heading", async () => {
    await open();

    expect(heading()).toHaveTextContent(LANGUAGE.activities[0]?.title ?? "");
  });

  it("leaves exactly one heading on the screen", async () => {
    /**
     * There were three — "Activity N of M — title", "Record" and "Result" —
     * two of which were labels on panels rather than anything a learner needed
     * named. A heading per region is form layout; a screen reader user
     * navigating by heading was being offered the component's structure.
     */
    await open();

    expect(screen.getAllByRole("heading")).toHaveLength(1);
  });

  it("stops saying the position in prose, and still says it to a screen reader", async () => {
    /**
     * The rail below the heading is the position indicator: one dot per
     * activity, the current one scaled up, and "Activity 1 of 10" as its
     * accessible name. Printing the same sentence above it is the count
     * duplication that was already cut once from this screen.
     */
    await open();

    expect(document.body.textContent).not.toMatch(/Activity \d+ of \d+/);
    expect(document.querySelector(".steps")?.getAttribute("aria-label")).toBe(
      `Activity 1 of ${LANGUAGE.activities.length}`,
    );
  });

  it("reads the streak the store already holds rather than counting the session", async () => {
    /**
     * The load-bearing one. Four days are seeded and nothing has been recorded
     * in this session, so a header showing four can only have read them —
     * anything derived from the takes on screen would show zero. It also means
     * a learner who is four days in is told so on activity one, not after ten.
     */
    installStorage({ "sonare.learnerName": "Marie" });
    seedStreak(4);

    await open();

    expect(chip()).toHaveTextContent("4 days in a row");
  });

  it("says nothing at all before there is a day to show", async () => {
    // "0 days in a row" is a scoreboard reading nil, which is the opposite of
    // what a streak is for.
    await open();

    expect(chip()).toBeNull();
  });

  it("credits the day on a take that could not be scored", async () => {
    /**
     * Attendance, never score — the rule is `recordPractice`'s signature, not
     * a comment: it takes no accuracy and no pass flag. A learner whose audio
     * came back unusable still practised, and R8 already says that take costs
     * them nothing, so it must not cost them the day either.
     */
    installStorage({ "sonare.learnerName": "Marie" });
    await open();

    take(null);

    await waitFor(() => expect(chip()).toHaveTextContent("Day 1"));
  });

  it("invites a first attempt before there is one, not a retry", async () => {
    await open();

    expect(screen.getByRole("button", { name: "Start speaking" })).toBeInTheDocument();
    expect(retryButton()).toBeNull();
  });

  it("puts going again and moving on side by side once there is a result", async () => {
    await open();

    take(88);

    await waitFor(() => expect(retryButton()).not.toBeNull());
    expect(nextButton()).not.toBeNull();
    expect(retryButton()?.closest(".row")).toBe(nextButton()?.closest(".row"));
  });

  it("makes moving on the louder of the two once there is a way on", async () => {
    /**
     * Both stay real choices: a learner who passed may want to beat their own
     * score. But two identically filled buttons make the pair ambiguous rather
     * than ordered, so the retry is the quieter one — offered, not urged.
     */
    await open();

    take(88);

    await waitFor(() => expect(retryButton()).not.toBeNull());
    expect(retryButton()?.className).toContain("ghost");
  });

  it("keeps the retry loud while it is the only thing to do", async () => {
    // Below the mark with tries left there is no way on yet, so nothing is
    // competing and the retry should not be whispering.
    await open();

    take(PASS_SCORE - 1);

    await waitFor(() => expect(retryButton()).not.toBeNull());
    expect(nextButton()).toBeNull();
    expect(retryButton()?.className).not.toContain("ghost");
  });
});
