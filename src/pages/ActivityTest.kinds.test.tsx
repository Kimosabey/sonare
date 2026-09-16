// @vitest-environment jsdom

/**
 * The screen, told which kind of activity it is showing.
 *
 * `ActivityTest` rendered every activity identically — phrase on screen,
 * Listen button beside Record — which is correct for `repeat` and silently
 * turns three of the other four into something easier:
 *
 *  - `read` with a Listen button **is** `repeat`. Working the pronunciation
 *    out from the spelling is the entire exercise, and a button that says it
 *    aloud first removes it.
 *  - `recall` with the phrase on screen **is** `read`. The target is what the
 *    learner is being asked to produce.
 *  - `listen` needs no microphone at all (N5), and opening one asks for a
 *    permission the activity never uses — on iOS, one a learner may only ever
 *    be offered once.
 *
 * None of those fail loudly. Each renders as a working screen teaching
 * something easier than intended, which is why they are asserted here on the
 * rendered result rather than only on `affordancesFor`. That function is
 * exhaustive and separately tested; this file is about the screen actually
 * reading it.
 *
 * The content is substituted, not the logic: `resolveLanguage` returns a set
 * of one activity per kind so each can be reached without driving a session
 * through ten real ones.
 */

import { useCallback, useState } from "react";
import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { RecorderState } from "../speech/capture/types.js";
import type { ActivityKind, LanguageActivitySet } from "../activities/types.js";

/* ── the content under test ─────────────────────────────────────────────── */

const TARGET = "Bonjour tout le monde";
const GLOSS = "Hello everyone";
/** A near-miss *meaning*, since a listen activity asks what the phrase meant. */
const NEAR_MISS = "Good evening everyone";

/** One activity of the named kind, and nothing else, so the screen opens on it. */
function setOf(kind: ActivityKind): LanguageActivitySet {
  return {
    code: "fr-FR",
    slug: "fr",
    label: "French",
    activities: [
      {
        id: 1,
        title: "Greeting",
        kind,
        prompt: "Say hello to the room",
        gloss: GLOSS,
        target: TARGET,
        focus: "the French r",
        ...(kind === "listen" ? { distractors: [NEAR_MISS] } : {}),
      },
    ],
  };
}

let activeSet: LanguageActivitySet = setOf("repeat");

vi.mock("../content/resolve.js", async () => {
  const actual = await vi.importActual<typeof import("../content/resolve.js")>(
    "../content/resolve.js",
  );
  return {
    ...actual,
    resolveLanguage: () => activeSet,
    resolveLanguages: () => [activeSet],
  };
});

/* ── the surrounding stubs, same posture as ActivityTest.test.tsx ────────── */

let scored: ((result: unknown, capture: unknown) => void) | null = null;
let lifecycle: ((state: RecorderState) => void) | null = null;
const startSpy = vi.fn();

vi.mock("../speech/react/useRecorder.js", () => ({
  useRecorder: (options: { onScored: (r: unknown, c: unknown) => void }) => {
    const [state, setState] = useState<RecorderState>("idle");
    const [result, setResult] = useState<unknown>(null);
    scored = (r, c) => {
      setResult(r);
      options.onScored(r, c);
      setState("idle");
    };
    lifecycle = (next) => setState(next);
    const doReset = useCallback(() => {
      setResult(null);
      setState("idle");
    }, []);
    // The real `start` clears the previous result before opening the
    // microphone, which is what takes the screen out of its result phase.
    const doStart = useCallback(() => {
      startSpy();
      setResult(null);
      setState("requesting");
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
      start: doStart,
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
vi.mock("../hooks/useSyllablePlayback.js", () => ({
  useSyllablePlayback: () => ({ playingOffsetTicks: null, play: vi.fn(), available: false }),
}));

/**
 * Available, unlike the default in the sibling file. Every assertion here is
 * about whether the *activity* permits the model, so the device having one has
 * to be true or the absences would all pass for the wrong reason.
 */
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

/**
 * Available by default. These tests are about what each *kind* offers, and an
 * unavailable microphone replaces the whole screen — so leaving it unstubbed
 * would make every spoken-kind assertion pass or fail for the wrong reason.
 */
let micState: import("../speech/capture/micCheck.js").MicAvailability = { state: "available" };
const micRecheck = vi.fn();
vi.mock("../hooks/useMicEnvironment.js", () => ({
  useMicEnvironment: () => ({
    availability: micState,
    inputCount: 1,
    origin: "https://sonare.example",
    recheck: micRecheck,
  }),
}));
vi.mock("../components/ToastProvider.js", () => ({
  useToast: () => ({ push: vi.fn(), dismiss: vi.fn(), clear: vi.fn() }),
}));

/* ── driving it ─────────────────────────────────────────────────────────── */

beforeEach(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return store.size;
      },
      clear: () => store.clear(),
      getItem: (k: string) => store.get(k) ?? null,
      key: (i: number) => [...store.keys()][i] ?? null,
      removeItem: (k: string) => void store.delete(k),
      setItem: (k: string, v: string) => void store.set(k, v),
    },
  });
  /**
   * jsdom has no `matchMedia`, and the score card's count-up asks it whether
   * motion is reduced. Same stub the component's own tests install, answering
   * "not reduced" so the ordinary path renders.
   */
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

  startSpy.mockClear();
  micState = { state: "available" };
});

afterEach(cleanup);

async function open(kind: ActivityKind) {
  activeSet = setOf(kind);
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

/** A passing take, landed through the recorder stub. */
function take(accuracy = 88): void {
  act(() =>
    scored?.(
      {
        accuracy,
        overall: accuracy,
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

const PROGRESS_KEY = "sonare.progress.v2.fr.anonymous";

/**
 * Stored progress as a previous sitting would have left it.
 *
 * Written straight to storage rather than driven through the screen, because
 * what is under test is a *return* visit — the screen opening on an activity
 * whose take happened in a session that has already ended.
 */
function seedAttempt(): void {
  localStorage.setItem(
    PROGRESS_KEY,
    JSON.stringify({
      index: 0,
      finished: false,
      progress: [
        {
          activityId: 1,
          attempts: [
            {
              kind: "spoken",
              activityId: 1,
              result: { indeterminate: false, provider: "azure", words: [] },
              accuracy: 55,
              at: "2026-09-01T10:00:00.000Z",
            },
          ],
          best: 55,
          passed: false,
          skipped: false,
        },
      ],
    }),
  );
}

function storedProgress(): { passed: boolean; attempts: unknown[] }[] {
  const raw = localStorage.getItem(PROGRESS_KEY);
  return (JSON.parse(raw ?? '{"progress":[]}') as { progress: { passed: boolean; attempts: unknown[] }[] })
    .progress;
}

function listenButton(): HTMLElement | null {
  return screen.queryByRole("button", { name: /^Listen$|^Stop$/ });
}

function phraseOnScreen(): boolean {
  return screen.queryAllByText(TARGET).length > 0;
}

/* ── the assertions ─────────────────────────────────────────────────────── */

describe("repeat", () => {
  it("shows the phrase and offers the model, which is the exercise", async () => {
    await open("repeat");

    expect(phraseOnScreen()).toBe(true);
    expect(listenButton()).toBeInTheDocument();
  });
});

describe("read", () => {
  /**
   * The defining absence. With a Listen button this is a `repeat`, and nothing
   * about the screen would say so.
   */
  it("offers no model before the first take", async () => {
    await open("read");

    expect(phraseOnScreen()).toBe(true);
    expect(listenButton()).not.toBeInTheDocument();
  });

  /**
   * When the unlock is actually reachable, which is not the tick after a take.
   *
   * A landed score puts the screen in its result phase, where the Listen
   * button does not render for any kind — hearing the model there is the
   * compare-to-model control's job. The `read` unlock matters when the learner
   * *comes back*: a second sitting on an activity they have already attempted
   * opens in the prompt phase with a take on record, and the model is feedback
   * by then rather than the answer.
   */
  it("offers the model when the learner returns to an activity they have attempted", async () => {
    seedAttempt();
    await open("read");

    expect(listenButton()).toBeInTheDocument();
  });

  it("still withholds it when the stored progress has no take on this activity", async () => {
    await open("read");
    expect(listenButton()).not.toBeInTheDocument();
  });
});

describe("recall", () => {
  it("hides the phrase and the model, since either one is the answer", async () => {
    await open("recall");

    expect(phraseOnScreen()).toBe(false);
    expect(listenButton()).not.toBeInTheDocument();
  });

  it("shows the English instead, which is what the learner works from", async () => {
    await open("recall");

    expect(screen.getByText(`“${GLOSS}”`)).toBeInTheDocument();
  });

  /**
   * The gloss is normally a quiet line below the actions. Standing in for the
   * phrase it must not also appear there — the same sentence twice at two
   * sizes reads as a rendering fault.
   */
  it("does not render the English twice", async () => {
    await open("recall");

    expect(screen.getAllByText(`“${GLOSS}”`)).toHaveLength(1);
  });

  it("says on the button what revealing will cost, before it is tapped", async () => {
    await open("recall");

    expect(screen.getByRole("button", { name: /this one won.t count/i })).toBeInTheDocument();
  });

  it("shows the phrase once revealed", async () => {
    await open("recall");
    fireEvent.click(screen.getByRole("button", { name: /this one won.t count/i }));

    expect(phraseOnScreen()).toBe(true);
    expect(listenButton()).toBeInTheDocument();
  });

  /**
   * What "won't count" has to mean. A take with the target on screen measures
   * reading, so recording it as a pass would let a learner complete a course
   * of `recall` activities without ever recalling one.
   */
  it("records nothing for a take made after revealing", async () => {
    await open("recall");
    fireEvent.click(screen.getByRole("button", { name: /this one won.t count/i }));
    take(95);

    expect(storedProgress().find((p) => p.passed)).toBeUndefined();
    // Nor recorded at all: a reveal is about this sitting, not about the
    // learner, so there is nothing here for a later session to read back.
    expect(storedProgress().flatMap((p) => p.attempts)).toHaveLength(0);
  });

  /**
   * Without a way on, the reveal is a trap: nothing counts, so the attempt
   * limit that normally unlocks "next" is never reached. The design forbids
   * hard gates and a screen with no exit is the hardest one there is.
   */
  it("offers a way on once revealed, since nothing can count any more", async () => {
    await open("recall");
    expect(
      screen.queryByRole("button", { name: /Next activity|Finish and see report/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /this one won.t count/i }));

    expect(
      screen.getByRole("button", { name: /Next activity|Finish and see report/i }),
    ).toBeInTheDocument();
  });

  it("keeps the model locked before a reveal even after the recorder opens", async () => {
    await open("recall");
    act(() => lifecycle?.("recording"));

    expect(listenButton()).not.toBeInTheDocument();
  });
});

describe("listen", () => {
  /**
   * N5, on the screen rather than in the rule. A learner meeting a listening
   * exercise must not be asked for a microphone it never uses.
   */
  it("offers no way to record", async () => {
    await open("listen");

    expect(screen.queryByRole("button", { name: /Can't speak right now/i })).not.toBeInTheDocument();
  });

  it("plays the model, which here is the question rather than a hint", async () => {
    await open("listen");

    expect(listenButton()).toBeInTheDocument();
  });

  /**
   * The property the exercise rests on. If the phrase were on screen, a
   * learner could match it against an option and be right without ever
   * pressing play.
   */
  it("does not show the spoken phrase while the question is open", async () => {
    await open("listen");

    expect(screen.queryAllByText(TARGET)).toHaveLength(0);
  });

  it("offers the meaning beside an authored near-miss meaning", async () => {
    await open("listen");

    expect(screen.getByRole("button", { name: GLOSS })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: NEAR_MISS })).toBeInTheDocument();
  });

  /**
   * English options carry no `lang`. Tagging them French would make a screen
   * reader say English meanings in a French voice — the mirror of the mistake
   * WCAG 3.1.2 exists to prevent.
   */
  it("leaves the English options untagged", async () => {
    await open("listen");

    const option = screen.getByRole("button", { name: GLOSS });
    expect(option.querySelector("[lang]")).toBeNull();
  });

  it("spends no try, because there is none to spend", async () => {
    await open("listen");

    expect(screen.queryByText(/tries left|Last try/)).not.toBeInTheDocument();
  });

  /**
   * One answer. A learner choosing between written phrases either heard the
   * difference or did not, and with two options a second guess is certain —
   * so the question ends and the right answer is shown.
   */
  it("ends the question on the first answer", async () => {
    await open("listen");
    fireEvent.click(screen.getByRole("button", { name: NEAR_MISS }));

    expect(screen.getByRole("button", { name: new RegExp(NEAR_MISS) })).toBeDisabled();
    expect(screen.getByRole("button", { name: new RegExp(GLOSS) })).toBeDisabled();
  });

  /**
   * Revealed only once the question is over. Before that it is the answer;
   * after it, seeing the phrase written is most of what makes the take worth
   * having — and it is the one thing here that carries `lang`.
   */
  it("reveals the phrase once the question is over, tagged", async () => {
    await open("listen");
    expect(screen.queryAllByText(TARGET)).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: GLOSS }));

    const revealed = screen.getByText(TARGET);
    expect(revealed).toBeInTheDocument();
    expect(revealed).toHaveAttribute("lang", "fr-FR");
  });

  /**
   * Marking the wrong answer without marking the right one leaves a learner
   * knowing they failed and not what they missed — which is the only thing
   * this activity exists to teach.
   */
  it("shows which was right, even when the learner picked wrong", async () => {
    await open("listen");
    fireEvent.click(screen.getByRole("button", { name: NEAR_MISS }));

    expect(screen.getByLabelText("correct").closest("button")).toHaveTextContent(GLOSS);
    expect(screen.getByLabelText("what you picked").closest("button")).toHaveTextContent(NEAR_MISS);
  });

  it("records a wrong answer as advanced without passing, not as untried", async () => {
    await open("listen");
    fireEvent.click(screen.getByRole("button", { name: NEAR_MISS }));

    const entry = storedProgress()[0];
    expect(entry?.passed).toBe(false);
    expect(entry?.attempts).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Next activity|Finish/i })).toBeInTheDocument();
  });

  it("passes on the right answer, with no accuracy invented for it", async () => {
    await open("listen");
    fireEvent.click(screen.getByRole("button", { name: GLOSS }));

    const entry = storedProgress()[0] as { passed: boolean; best: number | null } | undefined;
    expect(entry?.passed).toBe(true);
    expect(entry?.best).toBeNull();
  });

  /**
   * Content the publish gate refuses and `listenOptions` refuses again. It
   * still has to render as something a learner can get past rather than as a
   * screen with no options and no way on.
   */
  it("says so, rather than showing an unanswerable question", async () => {
    activeSet = {
      ...setOf("listen"),
      activities: [{ ...setOf("listen").activities[0]!, distractors: [] }],
    };
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

    expect(screen.getByText(/isn.t ready yet/i)).toBeInTheDocument();
  });
});

describe("when the microphone is unavailable mid-session", () => {
  /**
   * It outranks every other state on this screen. A learner who cannot record
   * would otherwise be left with the prompt, the try counter and a record
   * button that does nothing — which is what the toast version left behind.
   */
  it("replaces a spoken activity entirely", async () => {
    micState = { state: "denied" };
    await open("repeat");

    expect(screen.getByRole("heading", { name: /No microphone here/i })).toBeInTheDocument();
    expect(phraseOnScreen()).toBe(false);
    expect(screen.queryByText(/tries left|Last try/)).not.toBeInTheDocument();
  });

  /**
   * And leaves a listening activity alone, which is what makes "practise
   * listening instead" a real offer rather than a consolation.
   */
  it("does not block an activity that never needed one", async () => {
    micState = { state: "denied" };
    await open("listen");

    expect(screen.queryByRole("heading", { name: /No microphone here/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: GLOSS })).toBeInTheDocument();
  });

  it("does not block anything while the microphone is available", async () => {
    await open("repeat");
    expect(screen.queryByRole("heading", { name: /No microphone here/i })).not.toBeInTheDocument();
  });
});

describe("the sound check's verdict, carried forward", () => {
  function seedCheck(verdict: "good" | "quiet", deviceLabel: string | null = null): void {
    localStorage.setItem(
      "sonare.micCheck.v1.anonymous",
      JSON.stringify({ verdict, deviceLabel, at: new Date().toISOString() }),
    );
  }

  /**
   * The reassurance that is worth carrying. A learner whose first take comes
   * back unclear otherwise concludes the app cannot hear them, when a passed
   * check is evidence it can.
   */
  it("says an unclear take is the take, not the setup, after a passing check", async () => {
    seedCheck("good", "iPhone Microphone");
    await open("repeat");

    expect(screen.getByText(/Sound check passed/i)).toBeInTheDocument();
    expect(screen.getByText(/iPhone Microphone/)).toBeInTheDocument();
  });

  /** The same fact read the other way, so an unclear result is pre-explained. */
  it("says the check came out quiet instead, and offers to re-run it", async () => {
    seedCheck("quiet");
    await open("repeat");

    expect(screen.getByText(/came out quiet/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /run it again/i })).toBeInTheDocument();
  });

  it("says nothing at all when no check has been run", async () => {
    await open("repeat");
    expect(screen.queryByText(/Sound check passed/i)).not.toBeInTheDocument();
  });

  /**
   * Its whole usefulness is the window before the learner has evidence of
   * their own. After a take they can see what happened, and the line becomes
   * something to scroll past.
   */
  it("stops once the learner has a result of their own", async () => {
    seedCheck("good", "iPhone Microphone");
    await open("repeat");
    expect(screen.getByText(/Sound check passed/i)).toBeInTheDocument();

    take();

    expect(screen.queryByText(/Sound check passed/i)).not.toBeInTheDocument();
  });

  /** Nothing to reassure anyone about on an activity that never records. */
  it("says nothing on a listening activity", async () => {
    seedCheck("good", "iPhone Microphone");
    await open("listen");

    expect(screen.queryByText(/Sound check passed/i)).not.toBeInTheDocument();
  });
});

describe("leaving a sitting", () => {
  /**
   * Board 1i. Before this, Android's Back left the route immediately and Esc
   * did nothing — leaving was something that happened to a learner rather than
   * something they chose.
   */
  it("asks, rather than leaving, on Escape", async () => {
    await open("repeat");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.getByRole("dialog")).toHaveAccessibleName("Leave this sitting?");
  });

  /**
   * The gap, asserted rather than left implicit.
   *
   * The board asks for Android's system back to land on this dialog too. It
   * does not, and the attempt is recorded in `ActivityTest.tsx`: trapping
   * `popstate` from a `HashRouter` intercepted navigation it should not have,
   * and leaked a history entry per sitting so Back needed one more press each
   * time. This pins the current behaviour so that nobody reads the dialog's
   * existence as meaning Back is handled.
   */
  it("does not yet intercept system back — a known gap, not a silent one", async () => {
    await open("repeat");

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("carries on when the learner says keep going", async () => {
    await open("repeat");
    fireEvent.keyDown(window, { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: /Keep going/i }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(phraseOnScreen()).toBe(true);
  });

  /**
   * Nothing to leave before the sitting starts or after it ends, and trapping
   * Back on those screens would break the ordinary way out of the app.
   */
  it("does not trap Escape once the sitting is over", async () => {
    await open("repeat");
    take();
    // The result phase is still in the sitting; finishing is what ends it.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
