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

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { LANGUAGES, MAX_ATTEMPTS, PASS_SCORE } from "../activities/languages/index.js";

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
const reset = vi.fn();
const endSession = vi.fn();

vi.mock("../speech/react/useRecorder.js", () => ({
  useRecorder: (options: { onScored: (r: unknown, c: unknown) => void }) => {
    scored = options.onScored;
    return {
      state: "idle",
      speaking: false,
      level: -60,
      result: null,
      error: null,
      lastCapture: null,
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
  },
}));
vi.mock("../ui/useCaptureToasts.js", () => ({
  useCaptureToasts: () => undefined,
  HEARD_SPEECH_SNR_DB: 10,
}));
vi.mock("../ui/useSyllablePlayback.js", () => ({
  useSyllablePlayback: () => ({ playingOffsetTicks: null, play: vi.fn(), available: false }),
}));
vi.mock("../ui/useModelSpeech.js", () => ({
  useModelSpeech: () => ({ speak: vi.fn(), cancel: vi.fn(), speaking: false, available: false }),
}));
vi.mock("../ui/useWakeLock.js", () => ({ useWakeLock: () => undefined }));
vi.mock("../ui/ToastProvider.js", () => ({
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

/** "Attempt N of M" as rendered. */
function attemptLine(): string {
  return document.body.textContent?.match(/Attempt \d+ of \d+/)?.[0] ?? "";
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

    await waitFor(() => expect(document.body.textContent).toContain("Attempt"));
    expect(attemptLine()).toBe(before);
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

    await waitFor(() => expect(attemptLine()).toMatch(/Attempt 1 of/));
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

    await waitFor(() => expect(attemptLine()).toMatch(new RegExp(`Attempt 3 of ${MAX_ATTEMPTS}`)));
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

    await waitFor(() => expect(attemptLine()).toMatch(/Attempt 2 of/));
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

describe("the stated bar matches the gate", () => {
  it("tells the learner the number that actually decides it", async () => {
    /**
     * The gate reads `accuracy` and nothing else. Stating a bar the screen
     * then measures differently is the worst version of this — a learner
     * reading 68 against "pass at 60" and being told they did not pass has no
     * way to know which of the four displayed numbers was the exam.
     */
    await open();

    expect(document.body.textContent).toContain(`pass at ${PASS_SCORE}`);
  });

  it("states the try allowance it enforces", async () => {
    await open();

    expect(attemptLine()).toBe(`Attempt 1 of ${MAX_ATTEMPTS}`);
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

  it("counts passes rather than attempts in the summary", async () => {
    // "3 passed · 3 attempted" and "0 passed · 3 attempted" are different
    // sessions, and only the first is progress.
    await open();

    for (let i = 0; i < MAX_ATTEMPTS; i++) take(20);
    await waitFor(() => expect(nextButton()).not.toBeNull());
    fireEvent.click(nextButton()!);

    await waitFor(() => expect(document.body.textContent).toContain("0 passed"));
    expect(document.body.textContent).toContain("1 attempted");
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
