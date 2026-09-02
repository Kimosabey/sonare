/**
 * Per-activity microphone scope.
 *
 * releaseDevice() hands the capture device back — so the OS recording
 * indicator goes out between activities — while keeping the AudioContext and
 * its compiled worklet module. That split is the only reason per-activity
 * scope is affordable at all: if re-acquiring paid a full cold start,
 * releasing between ten activities would cost ten `new AudioContext()` +
 * `resume()` + `addModule()` cycles and blow NFR-01's 400ms budget.
 *
 * These tests assert the two halves of that claim directly: the device really
 * is released, and the expensive setup really is not repeated. Mocked the same
 * way as recorder.race.test.ts — none of the real capture APIs exist in a
 * plain-node environment, and what is under test is recorder.ts's own
 * lifecycle bookkeeping.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./constraints.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./constraints.js")>();
  return { ...actual, acquireMicrophone: vi.fn() };
});

vi.mock("./worklet.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./worklet.js")>();
  return { ...actual, addCaptureWorklet: vi.fn() };
});

beforeAll(() => {
  globalThis.document = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as Document;
});

function fakeTrack() {
  return { stop: vi.fn(), readyState: "live", onended: null } as unknown as MediaStreamTrack;
}

let contextsCreated = 0;

class FakeAudioContext {
  state = "running";
  sampleRate = 48000;
  destination = {};
  audioWorklet = {};
  onstatechange: (() => void) | null = null;
  constructor() {
    contextsCreated += 1;
  }
  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }
  close() {
    return Promise.resolve();
  }
}

/** A fresh device each call, so we can tell which one was stopped. */
function mockDevice(acquire: { mockResolvedValue: (v: never) => void }) {
  const track = fakeTrack();
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  acquire.mockResolvedValue({ stream, track, granted: null } as never);
  return track;
}

describe("Recorder per-activity scope", () => {
  beforeEach(() => {
    vi.resetModules();
    contextsCreated = 0;
    (globalThis as { window?: unknown }).window = { AudioContext: FakeAudioContext };
    (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode = class {
      port: { onmessage: unknown; postMessage: () => void } = { onmessage: null, postMessage: vi.fn() };
      connect = vi.fn();
      disconnect = vi.fn();
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode;
  });

  it("releaseDevice() stops the device — the OS indicator must actually go out", async () => {
    const { Recorder } = await import("./recorder.js");
    const { acquireMicrophone } = await import("./constraints.js");
    const { addCaptureWorklet } = await import("./worklet.js");
    vi.mocked(addCaptureWorklet).mockResolvedValue(undefined as never);

    const track = mockDevice(vi.mocked(acquireMicrophone));
    const recorder = new Recorder({}, {});
    await recorder.start();

    recorder.releaseDevice();

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(recorder.getState()).toBe("idle");
  });

  it("re-acquiring after releaseDevice() does not rebuild the context or recompile the worklet", async () => {
    const { Recorder } = await import("./recorder.js");
    const { acquireMicrophone } = await import("./constraints.js");
    const { addCaptureWorklet } = await import("./worklet.js");
    vi.mocked(addCaptureWorklet).mockResolvedValue(undefined as never);

    mockDevice(vi.mocked(acquireMicrophone));
    const recorder = new Recorder({}, {});
    await recorder.start();

    expect(contextsCreated).toBe(1);
    expect(vi.mocked(addCaptureWorklet)).toHaveBeenCalledTimes(1);

    // One activity boundary: device back, context kept.
    recorder.releaseDevice();
    mockDevice(vi.mocked(acquireMicrophone));
    await recorder.start();

    // The whole point. A second context or a second addModule() here would
    // mean per-activity release costs a full cold start every time.
    expect(contextsCreated).toBe(1);
    expect(vi.mocked(addCaptureWorklet)).toHaveBeenCalledTimes(1);
  });

  it("stays cheap across a ten-activity session", async () => {
    const { Recorder } = await import("./recorder.js");
    const { acquireMicrophone } = await import("./constraints.js");
    const { addCaptureWorklet } = await import("./worklet.js");
    vi.mocked(addCaptureWorklet).mockResolvedValue(undefined as never);

    mockDevice(vi.mocked(acquireMicrophone));
    const recorder = new Recorder({}, {});
    await recorder.start();

    for (let activity = 0; activity < 9; activity += 1) {
      recorder.releaseDevice();
      mockDevice(vi.mocked(acquireMicrophone));
      await recorder.start();
    }

    expect(contextsCreated).toBe(1);
    expect(vi.mocked(addCaptureWorklet)).toHaveBeenCalledTimes(1);
  });

  it("releaseMicrophone() is the harder teardown — the next start rebuilds everything", async () => {
    const { Recorder } = await import("./recorder.js");
    const { acquireMicrophone } = await import("./constraints.js");
    const { addCaptureWorklet } = await import("./worklet.js");
    vi.mocked(addCaptureWorklet).mockResolvedValue(undefined as never);

    mockDevice(vi.mocked(acquireMicrophone));
    const recorder = new Recorder({}, {});
    await recorder.start();

    recorder.releaseMicrophone();
    mockDevice(vi.mocked(acquireMicrophone));
    await recorder.start();

    // Session end must not leave a context alive to be reused, or the
    // distinction between the two release tiers would be meaningless.
    expect(contextsCreated).toBe(2);
    expect(vi.mocked(addCaptureWorklet)).toHaveBeenCalledTimes(2);
  });
});
