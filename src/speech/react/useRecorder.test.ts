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
    constructor(_options: unknown, given: typeof listeners) {
      listeners = given;
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
