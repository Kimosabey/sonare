// @vitest-environment jsdom

/**
 * Everything the learner is *told* during a take, and the one place R8 could
 * be broken by a helpful message.
 *
 * Two properties carry most of the weight.
 *
 * An indeterminate result must never produce a number — but "we couldn't hear
 * you" and "we heard you and couldn't match it" are different facts, and
 * collapsing them is actively harmful: telling someone who spoke clearly to be
 * louder sends them off to debug a microphone that is working perfectly. The
 * SNR of the take is what separates the two, which is why the advice is
 * conditional rather than one safe generic string.
 *
 * And every message shares one toast key, so a take produces one toast that
 * changes in place — "Listening" then "Scoring" then "Scored 87" — rather than
 * stacking five notifications over the prompt a learner is reading.
 */

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCaptureToasts, HEARD_SPEECH_SNR_DB } from "./useCaptureToasts.js";
import type { UseRecorderValue } from "../speech/react/useRecorder.js";

const push = vi.fn(() => 1);

vi.mock("./ToastProvider.js", () => ({
  useToast: () => ({ push, dismiss: vi.fn(), clear: vi.fn() }),
}));

interface Pushed {
  key?: string;
  kind?: string;
  title: string;
  detail?: string;
  duration?: number;
}

function pushes(): Pushed[] {
  return push.mock.calls.map((c) => (c as unknown as [Pushed])[0]);
}

function last(): Pushed {
  const all = pushes();
  const value = all[all.length - 1];
  if (!value) throw new Error("nothing was pushed");
  return value;
}

/** A recorder in a given state; only the fields this hook reads. */
function recorder(overrides: Partial<UseRecorderValue> = {}): UseRecorderValue {
  return {
    state: "idle",
    speaking: false,
    result: null,
    error: null,
    lastCapture: null,
    granted: null,
    contextSampleRate: null,
    ...overrides,
  } as unknown as UseRecorderValue;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  push.mockClear();
  vi.useFakeTimers();
  fetchMock = vi.fn(() => Promise.resolve({ ok: true } as Response));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Renders the hook and lets the caller drive the recorder through states. */
function drive(initial: Partial<UseRecorderValue> = {}, options: { autoStop?: boolean; announceScore?: boolean } = {}) {
  const view = renderHook(
    ({ r }: { r: UseRecorderValue }) => useCaptureToasts(r, { autoStop: options.autoStop ?? true, ...options }),
    { initialProps: { r: recorder(initial) } },
  );
  return {
    ...view,
    to: (next: Partial<UseRecorderValue>) => view.rerender({ r: recorder(next) }),
  };
}

describe("one take, one toast", () => {
  it("shares a single key across the whole lifecycle", () => {
    /**
     * Five stacked notifications for one action would bury the prompt. The key
     * is what makes them one toast that updates, so it has to be on every push
     * — a single message pushed without it stacks beside the rest.
     */
    const { to } = drive();

    to({ state: "requesting" });
    to({ state: "recording" });
    to({ state: "processing" });
    to({ state: "idle", result: { accuracy: 87, indeterminate: false } as never });

    expect(pushes().length).toBeGreaterThan(3);
    for (const p of pushes()) expect(p.key, p.title).toBe("capture");
  });

  it("pins the states that describe something ongoing", () => {
    // "Listening…" must not vanish while the learner is still talking, and
    // "Scoring…" must not vanish while they are waiting.
    const { to } = drive();

    to({ state: "recording" });
    expect(last().duration).toBe(0);

    to({ state: "processing" });
    expect(last().duration).toBe(0);
  });

  it("says nothing when the state has not actually changed", () => {
    // The hook is re-run on every level tick, thirty times a second. Pushing
    // on each would be thirty toasts per second for the length of the take.
    const { to } = drive();
    to({ state: "recording" });
    const after = push.mock.calls.length;

    to({ state: "recording" });
    to({ state: "recording" });

    expect(push.mock.calls.length).toBe(after);
  });
});

describe("what it says while recording", () => {
  it("names the microphone step, which is where a permission prompt appears", () => {
    const { to } = drive();

    to({ state: "requesting" });

    expect(last().title).toBe("Opening microphone…");
  });

  it("tells the learner it will stop on its own when it will", () => {
    const { to } = drive({}, { autoStop: true });

    to({ state: "recording" });

    expect(last().title).toBe("Listening…");
    expect(last().detail).toContain("stops on its own");
  });

  it("tells the learner to tap stop when it will not", () => {
    /**
     * The wrong instruction here is worse than none: someone waiting for an
     * auto-stop that is switched off records silence until the ceiling, and
     * the take is mostly room noise.
     */
    const { to } = drive({}, { autoStop: false });

    to({ state: "recording" });

    expect(last().title).toBe("Recording");
    expect(last().detail).toContain("Tap stop");
  });

  it("confirms it heard the first words", () => {
    // The reassurance a live transcript is usually wanted for.
    const { to } = drive({ state: "recording" }, { autoStop: true });

    to({ state: "recording", speaking: true });

    expect(last().title).toBe("Got you — keep going");
  });

  it("confirms it only once, not on every frame of speech", () => {
    const { to } = drive({ state: "recording" }, { autoStop: true });
    to({ state: "recording", speaking: true });
    const after = push.mock.calls.length;

    to({ state: "recording", speaking: true });

    expect(push.mock.calls.length).toBe(after);
  });

  it("does not promise an auto-stop that is switched off", () => {
    const { to } = drive({ state: "recording" }, { autoStop: false });

    to({ state: "recording", speaking: true });

    expect(pushes().some((p) => p.title === "Got you — keep going")).toBe(false);
  });
});

describe("the slow-scoring message", () => {
  it("explains the wait once silence starts reading as stuck", () => {
    /**
     * Measured p95 for the provider round-trip on this project is 3.74s, with
     * a max of 6.8s — so this fires on real takes, not only on pathological
     * ones. Past a few seconds a silent spinner reads as broken rather than
     * slow, and a learner taps away.
     */
    const { to } = drive();
    to({ state: "processing" });

    vi.advanceTimersByTime(4000);

    expect(last().title).toBe("Still scoring…");
    expect(last().detail).toContain("slow connection");
  });

  it("does not fire for a take that scored quickly", () => {
    // p50 is 922ms. Most takes must never see this message.
    const { to } = drive();
    to({ state: "processing" });

    vi.advanceTimersByTime(900);
    to({ state: "idle", result: { accuracy: 87, indeterminate: false } as never });
    vi.advanceTimersByTime(5000);

    expect(pushes().some((p) => p.title === "Still scoring…")).toBe(false);
  });

  it("cancels the timer on unmount", () => {
    // Otherwise it fires onto the next screen, describing a take that has
    // already finished.
    const { to, unmount } = drive();
    to({ state: "processing" });

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("announcing a score", () => {
  it("reports the number and grades the tone to it", () => {
    const cases: [number, string][] = [
      [92, "success"],
      [71, "info"],
      [42, "warn"],
    ];

    for (const [accuracy, kind] of cases) {
      push.mockClear();
      const { to } = drive({ state: "processing" });
      to({ state: "idle", result: { accuracy, indeterminate: false } as never });

      expect(last().title, String(accuracy)).toBe(`Scored ${Math.round(accuracy)}`);
      expect(last().kind, String(accuracy)).toBe(kind);
    }
  });

  it("points a low score at the thing that explains it", () => {
    // "Tap a word below" is the only route from a bad number to a reason.
    const { to } = drive({ state: "processing" });

    to({ state: "idle", result: { accuracy: 42, indeterminate: false } as never });

    expect(last().detail).toContain("Tap a word below");
  });

  it("stays quiet where the page already shows the result prominently", () => {
    /**
     * The activity screen renders the score card as the main content. A toast
     * repeating it is a second copy of the same information, arriving over the
     * word chips the learner is about to tap.
     */
    const { to } = drive({ state: "processing" }, { announceScore: false });

    to({ state: "idle", result: { accuracy: 87, indeterminate: false } as never });

    expect(pushes().some((p) => p.title.startsWith("Scored"))).toBe(false);
  });

  it("announces a repeated identical score on a fresh take", () => {
    // Two attempts can legitimately score the same. Deduplicating on value
    // rather than identity would leave attempt two silent.
    const { to } = drive({ state: "processing" });
    const first = { accuracy: 87, indeterminate: false } as never;
    to({ state: "idle", result: first });
    push.mockClear();

    to({ state: "processing", result: first });
    to({ state: "idle", result: { accuracy: 87, indeterminate: false } as never });

    expect(pushes().some((p) => p.title === "Scored 87")).toBe(true);
  });
});

describe("R8 — an indeterminate take", () => {
  it("never states a number", () => {
    /**
     * The honesty boundary, at the one place a well-meant message could break
     * it. A fabricated zero would be indistinguishable to a learner from a
     * real score of zero, and would be recorded as one in their own memory of
     * the session.
     */
    const { to } = drive({ state: "processing" });

    to({
      state: "idle",
      result: { indeterminate: true, reason: "no speech" } as never,
      lastCapture: { snrDb: 4 } as never,
    });

    expect(last().title).not.toMatch(/\d/);
    expect(last().detail ?? "").not.toMatch(/\bscored?\b/i);
  });

  it("tells a quiet take to be louder", () => {
    const { to } = drive({ state: "processing" });

    to({
      state: "idle",
      result: { indeterminate: true } as never,
      lastCapture: { snrDb: HEARD_SPEECH_SNR_DB - 5 } as never,
    });

    expect(last().title).toBe("Couldn't get a clear read");
    expect(last().detail).toContain("louder");
  });

  it("does not tell a clearly-recorded take to be louder", () => {
    /**
     * The distinction worth the extra branch. Real takes on this project
     * measured 12.8–33 dB SNR and scored 93–99, so a take above the threshold
     * genuinely was heard — the scorer simply could not match it to the
     * phrase. Advising more volume sends that learner to debug a microphone
     * that is fine, and the next take fails the same way.
     */
    const { to } = drive({ state: "processing" });

    to({
      state: "idle",
      result: { indeterminate: true } as never,
      lastCapture: { snrDb: HEARD_SPEECH_SNR_DB + 15 } as never,
    });

    expect(last().title).toBe("Couldn't match that to the phrase");
    expect(last().detail).toContain("slower");
    expect(last().detail).not.toContain("louder");
  });

  it("assumes the worse case when no SNR was recorded", () => {
    // Missing measurement must not be read as a good one — that would produce
    // the confident "we heard you clearly" on a take nothing measured.
    const { to } = drive({ state: "processing" });

    to({ state: "idle", result: { indeterminate: true } as never, lastCapture: null });

    expect(last().title).toBe("Couldn't get a clear read");
  });

  it("warns rather than celebrating", () => {
    const { to } = drive({ state: "processing" });

    to({ state: "idle", result: { indeterminate: true } as never });

    expect(last().kind).toBe("warn");
  });
});

describe("errors", () => {
  it("shows the learner-facing message, with the code as detail", () => {
    // The code is what makes a support conversation possible; it belongs in
    // the detail line, not the headline.
    const { to } = drive();

    to({
      state: "error",
      error: { code: "GESTURE_REQUIRED", domain: "client", userMessage: "Tap the record button to start.", detail: "x" } as never,
    });

    const shown = pushes().find((p) => p.kind === "error");
    expect(shown?.title).toBe("Tap the record button to start.");
    expect(shown?.detail).toBe("GESTURE_REQUIRED · client");
  });

  it("does not repeat an identical error code", () => {
    // A device-lost error can re-fire on every retry; three identical pinned
    // error toasts is three things to dismiss.
    const error = { code: "DEVICE_LOST", domain: "client", userMessage: "Microphone disconnected.", detail: "x" } as never;
    const { to } = drive();
    to({ state: "error", error });
    const after = push.mock.calls.filter((c) => (c as unknown as [Pushed])[0].kind === "error").length;

    to({ state: "error", error });

    expect(push.mock.calls.filter((c) => (c as unknown as [Pushed])[0].kind === "error").length).toBe(after);
  });

  it("reports a different code even right after the first", () => {
    const { to } = drive();
    to({ state: "error", error: { code: "DEVICE_LOST", domain: "client", userMessage: "a", detail: "x" } as never });

    to({ state: "error", error: { code: "PERMISSION_DENIED", domain: "client", userMessage: "b", detail: "x" } as never });

    expect(pushes().filter((p) => p.kind === "error")).toHaveLength(2);
  });

  it("re-reports a code after the error clears, since it is a new failure", () => {
    const error = { code: "DEVICE_LOST", domain: "client", userMessage: "a", detail: "x" } as never;
    const { to } = drive();
    to({ state: "error", error });

    to({ state: "idle", error: null });
    to({ state: "error", error });

    expect(pushes().filter((p) => p.kind === "error")).toHaveLength(2);
  });
});

describe("the diagnostic report", () => {
  it("sends the device signals only the client knows", () => {
    /**
     * `granted` and `contextSampleRate` cannot be recovered server-side, and
     * they are the two things that distinguish "this platform ignored our
     * constraints" from "this learner's room is noisy" — which is the whole
     * question R5 exists to answer.
     */
    const { to } = drive();

    to({
      state: "error",
      error: { code: "SNR_TOO_LOW", domain: "client", userMessage: "Too quiet.", detail: "snr 3dB" } as never,
      granted: { autoGainControl: true } as never,
      contextSampleRate: 48000,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      code: string;
      context: { granted: unknown; contextSampleRate: number; userAgent: string };
    };
    expect(body.code).toBe("SNR_TOO_LOW");
    expect(body.context.granted).toEqual({ autoGainControl: true });
    expect(body.context.contextSampleRate).toBe(48000);
    expect(typeof body.context.userAgent).toBe("string");
  });

  it("carries the correlation fields that make a funnel readable", () => {
    const view = renderHook(() =>
      useCaptureToasts(
        recorder({
          state: "error",
          error: { code: "SNR_TOO_LOW", domain: "client", userMessage: "q", detail: "d" } as never,
        }),
        { autoStop: true, sessionId: "s-1", activityId: 4, learnerName: "speaker-a" },
      ),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.sessionId).toBe("s-1");
    expect(body.activityId).toBe(4);
    expect(body.learnerName).toBe("speaker-a");
    view.unmount();
  });

  it("sends the internal detail to the server and the safe text to the learner", () => {
    // The trail needs the technical string; the toast must not carry it.
    const { to } = drive();

    to({
      state: "error",
      error: { code: "SNR_TOO_LOW", domain: "client", userMessage: "Too quiet.", detail: "snr 3.1dB floor -41" } as never,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { message: string; userMessage: string };
    expect(body.message).toBe("snr 3.1dB floor -41");
    expect(body.userMessage).toBe("Too quiet.");
    expect(pushes().find((p) => p.kind === "error")?.title).toBe("Too quiet.");
  });

  it("never surfaces a failed report as its own error", () => {
    /**
     * A learner whose capture failed should not then be shown a second error
     * about the failure of the report about the first error. And these two are
     * correlated: a dead connection causes the capture failure and the failed
     * POST alike.
     */
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const { to } = drive();

    to({
      state: "error",
      error: { code: "UPLOAD_FAILED", domain: "network", userMessage: "Upload failed.", detail: "x" } as never,
    });

    expect(pushes().filter((p) => p.kind === "error")).toHaveLength(1);
  });

  it("reports nothing when nothing failed", () => {
    const { to } = drive();

    to({ state: "recording" });
    to({ state: "idle", result: { accuracy: 87, indeterminate: false } as never });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
