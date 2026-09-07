// @vitest-environment jsdom

/**
 * The seam where the capture state machine meets React — 315 lines that owned
 * no tests, and the only place the two halves of this app are wired together.
 *
 * What is worth pinning here is not the Recorder (recorder.test.ts and
 * recorder.race.test.ts cover that) nor the upload (client.test.ts), but the
 * decisions the hook itself makes: what reaches the UI, what is deliberately
 * kept out of it, and what happens to a take between stopping and scoring.
 *
 * Recorder and scoreRecording are both stubbed. Neither can run here — one
 * needs getUserMedia and an AudioWorklet, the other a server — and mocking
 * them is what leaves the hook's own logic as the subject.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureResult } from "../capture/types.js";
import type { PronunciationResult } from "../scoring/types.js";

/** Listeners the hook hands the Recorder, captured so tests can drive them. */
let listeners: {
  onState?: (s: string) => void;
  onLevel?: (dbfs: number) => void;
  onError?: (e: unknown) => void;
  onAutoStop?: () => void;
  onSpeechStart?: () => void;
  onClipping?: (hot: boolean) => void;
} = {};

/** Options each Recorder was constructed with, in order. */
const constructedWith: Record<string, unknown>[] = [];

const recorderStub = {
  start: vi.fn(() => Promise.resolve()),
  stop: vi.fn(() => Promise.resolve(CAPTURE)),
  cancel: vi.fn(),
  dispose: vi.fn(),
  releaseMicrophone: vi.fn(),
  releaseDevice: vi.fn(),
  getState: vi.fn(() => "idle"),
  getGrantedConstraints: vi.fn(() => null),
  getContextSampleRate: vi.fn(() => 48000),
};

vi.mock("../capture/recorder.js", () => ({
  // A class, not vi.fn(() => …): the hook calls `new Recorder(...)`, and an
  // arrow function has no [[Construct]]. Returning an object from a
  // constructor replaces the instance, which is what hands the stub back.
  Recorder: class {
    constructor(options: unknown, given: typeof listeners) {
      listeners = given;
      constructedWith.push(options as Record<string, unknown>);
      return recorderStub as unknown as this;
    }
  },
  hangoverForReference: () => 2000,
}));

const scoreRecording = vi.fn(() => Promise.resolve(SCORED));
vi.mock("../scoring/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scoring/client.js")>();
  return { ...actual, scoreRecording: (...args: unknown[]) => scoreRecording(...(args as [])) };
});

const CAPTURE: CaptureResult = {
  wav: new Blob([new Uint8Array(8)], { type: "audio/wav" }),
  durationSeconds: 2,
  contextSampleRate: 48000,
  granted: {
    echoCancellation: false,
    autoGainControl: false,
    noiseSuppression: false,
    channelCount: 1,
    sampleRate: 48000,
    deviceId: "d",
  },
  snrDb: 24,
  peakDbfs: -6,
  endpoint: { thresholdDb: -40, noiseFloorDb: -60, peakDb: -8, autoStopped: false },
};

const SCORED: PronunciationResult = {
  indeterminate: false,
  provider: "azure",
  recognized: "Bonjour",
  overall: 93,
  accuracy: 95,
  fluency: 90,
  completeness: 100,
  words: [],
};

async function load() {
  return (await import("./useRecorder.js")).useRecorder;
}

/**
 * Renders the hook with its Recorder already constructed.
 *
 * The hook creates one lazily inside ensureRecorder(), which only start() and
 * warm() call — so on a bare mount there is no instance and no listeners to
 * drive. warm() is the honest way to prime it: it is exactly what ActivityTest
 * does before a learner's first tap, and with getState() reporting "idle" it
 * leaves no take running.
 */
async function mount(over: Record<string, unknown> = {}) {
  const useRecorder = await load();
  const hook = renderHook(() => useRecorder(options(over)));
  await act(async () => {
    hook.result.current.warm();
  });
  return hook;
}

function options(over: Record<string, unknown> = {}) {
  return {
    referenceText: "Bonjour, comment allez-vous",
    language: "fr-FR",
    sessionId: "session-1",
    activityId: 3,
    ...over,
  };
}

beforeEach(() => {
  listeners = {};
  constructedWith.length = 0;
  vi.clearAllMocks();
  recorderStub.start.mockResolvedValue(undefined);
  recorderStub.stop.mockResolvedValue(CAPTURE);
  recorderStub.getState.mockReturnValue("idle");
  scoreRecording.mockResolvedValue(SCORED);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useRecorder — what reaches the UI", () => {
  it("starts idle with nothing to show", async () => {
    const { result } = await mount();

    expect(result.current.state).toBe("idle");
    expect(result.current.result).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.lastCapture).toBeNull();
  });

  it("keeps the level out of React state entirely", async () => {
    // The whole point of levelStore: a 30Hz signal must not re-render the page
    // that owns this hook. If `level` ever reappears as a value here, that
    // regression is silent — hence asserting the shape.
    const { result } = await mount();

    expect(result.current).not.toHaveProperty("level");
    expect(typeof result.current.levelStore.subscribe).toBe("function");
    expect(result.current.levelStore.getSnapshot()).toBe(-90);
  });

  it("routes capture levels to the store rather than to a setState", async () => {
    const { result } = await mount();

    act(() => {
      result.current.start();
      listeners.onLevel?.(-33);
    });

    expect(result.current.levelStore.getSnapshot()).toBe(-33);
  });

  it("surfaces state, speech and clipping from the capture layer", async () => {
    const { result } = await mount();

    act(() => {
      listeners.onState?.("recording");
      listeners.onSpeechStart?.();
      listeners.onClipping?.(true);
    });

    expect(result.current.state).toBe("recording");
    expect(result.current.speaking).toBe(true);
    expect(result.current.clipping).toBe(true);
  });
});

describe("useRecorder — scoring a take", () => {
  it("uploads the capture and exposes the result", async () => {
    const { result } = await mount();

    act(() => result.current.start());
    // stop() returns early unless the recorder says it is recording — a real
    // guard against a stray second tap, so the stub has to reflect a take in
    // progress rather than the test bypassing it.
    recorderStub.getState.mockReturnValue("recording");
    await act(async () => {
      result.current.stop();
    });

    await waitFor(() => expect(result.current.result).toEqual(SCORED));
    expect(scoreRecording).toHaveBeenCalledTimes(1);
  });

  it("passes the capture's own measurements through to the upload", async () => {
    // deviceContext is the analysis trail: an attempt recorded without its SNR
    // and granted constraints cannot be interpreted afterwards.
    const { result } = await mount();

    act(() => result.current.start());
    // stop() returns early unless the recorder says it is recording — a real
    // guard against a stray second tap, so the stub has to reflect a take in
    // progress rather than the test bypassing it.
    recorderStub.getState.mockReturnValue("recording");
    await act(async () => {
      result.current.stop();
    });

    await waitFor(() => expect(scoreRecording).toHaveBeenCalled());
    const [req] = scoreRecording.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(req.snrDb).toBe(24);
    expect(req.peakDbfs).toBe(-6);
    expect(req.contextSampleRate).toBe(48000);
    expect(req.sessionId).toBe("session-1");
    expect(req.referenceText).toBe("Bonjour, comment allez-vous");
  });

  it("notifies the owner with both the score and the capture behind it", async () => {
    // FixtureRunner logs the capture alongside the result; a callback given
    // only the score could not record what produced it.
    const onScored = vi.fn();
    const { result } = await mount({ onScored });

    act(() => result.current.start());
    // stop() returns early unless the recorder says it is recording — a real
    // guard against a stray second tap, so the stub has to reflect a take in
    // progress rather than the test bypassing it.
    recorderStub.getState.mockReturnValue("recording");
    await act(async () => {
      result.current.stop();
    });

    await waitFor(() => expect(onScored).toHaveBeenCalledTimes(1));
    const [scored, capture] = onScored.mock.calls[0] as [PronunciationResult, CaptureResult];
    expect(scored).toEqual(SCORED);
    expect(capture.snrDb).toBe(24);
  });

  it("keeps an indeterminate result as a result, not an error", async () => {
    // R8: "I could not get a clear read" is a successful answer. Routing it to
    // `error` would make the UI show a failure banner instead of the honest
    // unclear state, and would burn one of the learner's three tries.
    const indeterminate: PronunciationResult = {
      indeterminate: true,
      provider: "azure",
      reason: "no speech found to assess",
    };
    scoreRecording.mockResolvedValue(indeterminate);

    const { result } = await mount();

    act(() => result.current.start());
    // stop() returns early unless the recorder says it is recording — a real
    // guard against a stray second tap, so the stub has to reflect a take in
    // progress rather than the test bypassing it.
    recorderStub.getState.mockReturnValue("recording");
    await act(async () => {
      result.current.stop();
    });

    await waitFor(() => expect(result.current.result).toEqual(indeterminate));
    expect(result.current.error).toBeNull();
  });

  it("surfaces an upload failure as an error and leaves the result empty", async () => {
    const { ScoringError } = await import("../scoring/client.js");
    scoreRecording.mockRejectedValue(
      new ScoringError("NETWORK_FAILED", "network", "fetch failed", "Couldn't reach the server."),
    );

    const { result } = await mount();

    act(() => result.current.start());
    // stop() returns early unless the recorder says it is recording — a real
    // guard against a stray second tap, so the stub has to reflect a take in
    // progress rather than the test bypassing it.
    recorderStub.getState.mockReturnValue("recording");
    await act(async () => {
      result.current.stop();
    });

    await waitFor(() => expect(result.current.error?.code).toBe("NETWORK_FAILED"));
    expect(result.current.result).toBeNull();
    expect(result.current.error?.userMessage).toBe("Couldn't reach the server.");
  });

  it("clears the previous result when a new take begins", async () => {
    // A stale score sitting under a fresh recording is the worst possible
    // ambiguity: the learner cannot tell which attempt it belongs to.
    const { result } = await mount();

    act(() => result.current.start());
    // stop() returns early unless the recorder says it is recording — a real
    // guard against a stray second tap, so the stub has to reflect a take in
    // progress rather than the test bypassing it.
    recorderStub.getState.mockReturnValue("recording");
    await act(async () => {
      result.current.stop();
    });
    await waitFor(() => expect(result.current.result).not.toBeNull());

    act(() => result.current.start());

    expect(result.current.result).toBeNull();
  });
});

describe("useRecorder — capture errors", () => {
  it("shows a capture error with its code and its advice", async () => {
    const { CaptureError } = await import("../capture/errors.js");
    const { result } = await mount();

    act(() => {
      listeners.onError?.(
        new CaptureError("SNR_TOO_LOW", "client", "SNR 4 dB below 10 dB", "It's too noisy to score fairly."),
      );
    });

    expect(result.current.error?.code).toBe("SNR_TOO_LOW");
    expect(result.current.error?.userMessage).toBe("It's too noisy to score fairly.");
  });

  it("clears a previous error when the learner tries again", async () => {
    const { CaptureError } = await import("../capture/errors.js");
    const { result } = await mount();

    act(() => {
      listeners.onError?.(new CaptureError("SNR_TOO_LOW", "client", "noisy", "Too noisy."));
    });
    expect(result.current.error).not.toBeNull();

    act(() => result.current.start());

    expect(result.current.error).toBeNull();
  });
});

describe("useRecorder — the microphone lifecycle", () => {
  it("releases the device without tearing down the audio graph", async () => {
    // Per-activity scope: the OS indicator goes out between activities while
    // the expensive context survives.
    const { result } = await mount();

    act(() => result.current.releaseDevice());

    expect(recorderStub.releaseDevice).toHaveBeenCalledTimes(1);
    expect(recorderStub.releaseMicrophone).not.toHaveBeenCalled();
  });

  it("ends a session by releasing the microphone outright", async () => {
    const { result } = await mount();

    act(() => result.current.endSession());

    expect(recorderStub.releaseMicrophone).toHaveBeenCalledTimes(1);
    expect(result.current.sessionActive).toBe(false);
  });

  it("resets the level to silence on release, so no stale bar lingers", async () => {
    const { result } = await mount();

    act(() => {
      listeners.onLevel?.(-20);
    });
    expect(result.current.levelStore.getSnapshot()).toBe(-20);

    act(() => result.current.releaseDevice());

    expect(result.current.levelStore.getSnapshot()).toBe(-90);
  });

  it("disposes the recorder on unmount rather than leaving the mic open", async () => {
    const { unmount } = await mount();

    unmount();

    expect(recorderStub.dispose).toHaveBeenCalled();
  });

  it("warms without leaving a take running", async () => {
    // warm() exists purely to pay the getUserMedia cost early; if it left the
    // recorder recording, the learner's first tap would score silence.
    recorderStub.getState.mockReturnValue("recording");
    const { result } = await mount();

    await act(async () => {
      result.current.warm();
    });

    await waitFor(() => expect(recorderStub.cancel).toHaveBeenCalled());
  });
});

/**
 * Four behaviours a mutation sweep found unpinned, all of them about *when*
 * the microphone is running and *which* configuration it is running under.
 *
 * These are the worst kind to leave unguarded, because none of them announces
 * itself: the mic stays live when it should not, or a take is scored against
 * the wrong phrase's settings. The learner sees a plausible number either way.
 */
describe("useRecorder — continuous mode is opt-in", () => {
  it("does not start another take by itself when continuous is off", async () => {
    /**
     * The default, and the one that matters. With the guard flattened, scoring
     * a take immediately begins the next one — so a learner who has finished
     * speaking has a live microphone and a recording indicator they never
     * asked for, on a screen showing them their score.
     */
    const hook = await mount({ continuous: false });
    act(() => void hook.result.current.start());
    // stop() returns early unless the recorder reports a take in progress —
    // a real guard against a stray second tap, so the stub has to reflect one.
    recorderStub.getState.mockReturnValue("recording");
    recorderStub.start.mockClear();

    await act(async () => {
      listeners.onAutoStop?.();
    });
    await waitFor(() => expect(hook.result.current.result).toEqual(SCORED));

    expect(recorderStub.start).not.toHaveBeenCalled();
  });

  it("starts the next take when continuous is on and the session is live", async () => {
    // The other side: segmenting on each silence is the whole point of
    // continuous mode, and it must actually happen.
    const hook = await mount({ continuous: true });
    await act(async () => {
      await hook.result.current.start();
    });
    recorderStub.getState.mockReturnValue("recording");
    recorderStub.start.mockClear();

    await act(async () => {
      listeners.onAutoStop?.();
    });

    await waitFor(() => expect(recorderStub.start).toHaveBeenCalled());
  });

  it("stops segmenting once the session has ended", async () => {
    /**
     * Both halves of the condition are load-bearing. `continuous` alone would
     * keep the microphone segmenting after the learner ended the session,
     * which is the same lit-indicator problem arriving by a different route.
     */
    const hook = await mount({ continuous: true });
    await act(async () => {
      await hook.result.current.start();
    });
    await act(async () => {
      hook.result.current.endSession();
    });
    recorderStub.getState.mockReturnValue("recording");
    recorderStub.start.mockClear();

    await act(async () => {
      listeners.onAutoStop?.();
    });

    expect(recorderStub.start).not.toHaveBeenCalled();
  });
});

describe("useRecorder — the recorder matches its capture settings", () => {
  it("builds a new recorder when the silence window changes", async () => {
    /**
     * The key is the capture configuration — auto-stop and the hangover — not
     * the phrase, which is deliberately read through a ref at take time so
     * changing the prompt mid-session cannot score a take against a phrase the
     * learner was not shown.
     *
     * The hangover still tracks the phrase in practice: ActivityTest derives
     * it from the target's length. So reusing a recorder across that change
     * would run a short phrase on a long phrase's silence window — waiting too
     * long to stop, or cutting the learner off — and neither errors.
     */
    const useRecorder = await load();
    const hook = renderHook(
      ({ hangover }: { hangover: number }) =>
        useRecorder(options({ autoStop: true, silenceHangoverMs: hangover })),
      { initialProps: { hangover: 1200 } },
    );
    await act(async () => {
      hook.result.current.warm();
    });
    const first = listeners;

    hook.rerender({ hangover: 2600 });
    await act(async () => {
      hook.result.current.warm();
    });

    // A fresh construction installs a fresh listener bag.
    expect(listeners).not.toBe(first);
  });

  it("keeps one recorder across a phrase change on its own", async () => {
    // The counterpart: the phrase alone must not tear down and re-acquire the
    // microphone, which is what reading it through a ref buys.
    const useRecorder = await load();
    const hook = renderHook(({ text }: { text: string }) => useRecorder(options({ referenceText: text })), {
      initialProps: { text: "Bonjour" },
    });
    await act(async () => {
      hook.result.current.warm();
    });
    const first = listeners;

    hook.rerender({ text: "Je voudrais un café" });
    await act(async () => {
      hook.result.current.warm();
    });

    expect(listeners).toBe(first);
  });

  it("reuses the recorder while the phrase is unchanged", async () => {
    // The other side: rebuilding on every render would tear down and
    // re-acquire the microphone constantly, which is what the key exists to
    // prevent.
    const useRecorder = await load();
    const hook = renderHook(() => useRecorder(options()));
    await act(async () => {
      hook.result.current.warm();
    });
    const first = listeners;

    hook.rerender();
    await act(async () => {
      hook.result.current.warm();
    });

    expect(listeners).toBe(first);
  });
});

describe("useRecorder — a stumble does not end a continuous session", () => {
  /**
   * `recorder.stop()` rejects on an utterance the capture layer refuses — too
   * short, too noisy. In continuous mode that must re-arm rather than end the
   * session, or a learner has to restart it after every stumble, which is
   * exactly the moment they are most likely to stumble again.
   */
  it("re-arms after a rejected utterance when continuous", async () => {
    const hook = await mount({ continuous: true });
    await act(async () => {
      await hook.result.current.start();
    });
    recorderStub.getState.mockReturnValue("recording");
    recorderStub.stop.mockRejectedValueOnce(new Error("too short"));
    recorderStub.start.mockClear();

    await act(async () => {
      hook.result.current.stop();
    });

    await waitFor(() => expect(recorderStub.start).toHaveBeenCalled());
  });

  it("does not re-arm after a rejected utterance when not continuous", async () => {
    // The other side, and the one that leaves a microphone live: a refused
    // take on a single-utterance screen must simply be over.
    const hook = await mount({ continuous: false });
    act(() => void hook.result.current.start());
    recorderStub.getState.mockReturnValue("recording");
    recorderStub.stop.mockRejectedValueOnce(new Error("too short"));
    recorderStub.start.mockClear();

    await act(async () => {
      hook.result.current.stop();
    });

    expect(recorderStub.start).not.toHaveBeenCalled();
  });

  it("does not re-arm after a rejected utterance once the session has ended", async () => {
    const hook = await mount({ continuous: true });
    await act(async () => {
      await hook.result.current.start();
    });
    await act(async () => {
      hook.result.current.endSession();
    });
    recorderStub.getState.mockReturnValue("recording");
    recorderStub.stop.mockRejectedValueOnce(new Error("too short"));
    recorderStub.start.mockClear();

    await act(async () => {
      hook.result.current.stop();
    });

    expect(recorderStub.start).not.toHaveBeenCalled();
  });
});

describe("useRecorder — the capture options it hands down", () => {
  it("omits the silence window rather than passing undefined", async () => {
    /**
     * A conditional spread, not `silenceHangoverMs: options.silenceHangoverMs`.
     * The Recorder derives its own default from the phrase when the key is
     * absent; handing it an explicit `undefined` relies on every consumer
     * treating the two alike, which is the kind of assumption
     * `exactOptionalPropertyTypes` exists to stop being true by accident.
     */
    await mount({ autoStop: true });

    expect(constructedWith[0]).not.toHaveProperty("silenceHangoverMs");
  });

  it("passes it through when there is one", async () => {
    await mount({ autoStop: true, silenceHangoverMs: 1800 });

    expect(constructedWith[0]).toMatchObject({ silenceHangoverMs: 1800, autoStop: true });
  });
});

describe("useRecorder — ending a session mid-phrase", () => {
  it("scores the utterance in progress rather than discarding it", async () => {
    /**
     * A learner who taps end while still speaking has already said the phrase.
     * Throwing that take away costs them the attempt — and with the comparison
     * inverted, the *only* takes that get scored are the ones that were not
     * being recorded, which is exactly backwards.
     */
    const hook = await mount();
    recorderStub.getState.mockReturnValue("recording");

    await act(async () => {
      hook.result.current.endSession();
    });

    await waitFor(() => expect(recorderStub.stop).toHaveBeenCalled());
  });

  it("does not try to stop a recorder that is not recording", async () => {
    // Ending an idle session must not call stop() and manufacture a take out
    // of nothing.
    const hook = await mount();
    recorderStub.getState.mockReturnValue("idle");
    recorderStub.stop.mockClear();

    await act(async () => {
      hook.result.current.endSession();
    });

    expect(recorderStub.stop).not.toHaveBeenCalled();
  });

  it("survives every lifecycle call before any recorder exists", async () => {
    /**
     * Each recorder access on these paths is optional-chained because a
     * learner can open a screen and leave without ever tapping record — and
     * the cleanup still runs. Unchaining any of them throws on a screen the
     * learner never used.
     */
    const useRecorder = await load();
    const hook = renderHook(() => useRecorder(options()));

    expect(() => {
      act(() => {
        hook.result.current.stop();
        hook.result.current.endSession();
        hook.result.current.releaseDevice();
        hook.result.current.reset();
      });
    }).not.toThrow();
    expect(() => hook.unmount()).not.toThrow();
  });
});

/**
 * Three defaults where `??` and `||` are not interchangeable, and the option
 * being defaulted is falsy on purpose.
 *
 * None of these is a bug today — the code uses `??` and is right. They are
 * here because the difference is invisible until someone "simplifies" one, and
 * then a caller who deliberately turned something off finds it still on.
 * `enforceSnrGate: false` is the one that matters most: recorder.ts documents
 * it as existing so the fixture runner can keep a raw take either way, and
 * `false || true` is `true`.
 */
describe("useRecorder — defaults that must not swallow a falsy option", () => {
  it("honours enforceSnrGate: false rather than defaulting it back on", async () => {
    await mount({ enforceSnrGate: false });

    expect(constructedWith[0]).toMatchObject({ enforceSnrGate: false });
  });

  it("still defaults the gate on when nothing was said", async () => {
    // The gate protects a learner from spending an attempt on audio the
    // scorer cannot read, so absent must mean on.
    await mount();

    expect(constructedWith[0]).toMatchObject({ enforceSnrGate: true });
  });

  it("honours a minimum SNR of zero rather than substituting ten", async () => {
    // Zero is how a caller says "measure everything" — the fixture's own
    // stance. `0 || 10` is 10, which would quietly re-impose the gate the
    // caller had just lifted.
    await mount({ minSnrDb: 0 });

    expect(constructedWith[0]).toMatchObject({ minSnrDb: 0 });
  });

  it("defaults the minimum SNR when nothing was said", async () => {
    await mount();

    expect(constructedWith[0]).toMatchObject({ minSnrDb: 10 });
  });

  it("honours autoStop: false", async () => {
    // The one case where `||` happens to agree — asserted anyway, because the
    // agreement is a coincidence of the default rather than a property.
    await mount({ autoStop: false });

    expect(constructedWith[0]).toMatchObject({ autoStop: false });
  });
});
