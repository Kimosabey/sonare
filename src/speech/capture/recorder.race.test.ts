/**
 * Regression coverage for the `generation` counter — recorder.ts's own guard
 * against cancelling start() while it's mid-await. The class-level comment
 * on `generation` documents the exact historical bug this protects against:
 * "cancelling while getUserMedia is still resolving does nothing... The
 * permission then resolves into an orphaned recorder that opens the
 * microphone and captures forever, with no reference left to stop it."
 *
 * acquireMicrophone()/addCaptureWorklet() are mocked with controllable
 * promises rather than driven through real getUserMedia/AudioContext/
 * AudioWorklet — none of those exist in this plain-node test environment,
 * and the race itself lives entirely in recorder.ts's own stale() checks,
 * not in the real capture APIs.
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

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function fakeTrack() {
  return { stop: vi.fn(), readyState: "live", onended: null } as unknown as MediaStreamTrack;
}

describe("Recorder generation counter", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("cancel() during the acquireMicrophone() await releases the stream instead of orphaning it", async () => {
    const { Recorder } = await import("./recorder.js");
    const { acquireMicrophone } = await import("./constraints.js");

    const track = fakeTrack();
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    const { promise, resolve } = deferred<{ stream: MediaStream; track: MediaStreamTrack; granted: unknown }>();
    vi.mocked(acquireMicrophone).mockReturnValue(promise as never);

    const recorder = new Recorder({}, {});
    const startPromise = recorder.start(); // begins awaiting acquireMicrophone()

    // Cancel while the mic request is still pending — bumps `generation`.
    recorder.cancel();
    expect(recorder.getState()).toBe("idle");

    // The permission prompt resolves after the cancel.
    resolve({ stream, track, granted: null });
    await startPromise;

    // The orphaned-recorder bug: the stream must be handed straight back,
    // not left open with the OS mic indicator lit and nothing able to stop it.
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(recorder.getState()).toBe("idle");
  });

  it("cancel() during the buildGraph() await (after the mic is already granted) still tears the stream down", async () => {
    const { Recorder } = await import("./recorder.js");
    const { acquireMicrophone } = await import("./constraints.js");
    const { addCaptureWorklet } = await import("./worklet.js");

    const track = fakeTrack();
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    vi.mocked(acquireMicrophone).mockResolvedValue({ stream, track, granted: null } as never);

    const { promise: workletPromise, resolve: resolveWorklet } = deferred<void>();
    vi.mocked(addCaptureWorklet).mockReturnValue(workletPromise as never);

    class FakeAudioContext {
      state = "running";
      sampleRate = 48000;
      destination = {};
      audioWorklet = {};
      onstatechange: (() => void) | null = null;
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      close() {
        return Promise.resolve();
      }
    }
    (globalThis as { window?: unknown }).window = { AudioContext: FakeAudioContext };

    const recorder = new Recorder({}, {});
    const startPromise = recorder.start();

    // Let acquireMicrophone() resolve and start() proceed into buildGraph(),
    // which is now awaiting addCaptureWorklet() — mocked to hang until
    // resolveWorklet() is called below. Poll microtasks rather than guess a
    // fixed count, since exactly how many ticks acquireMicrophone()'s
    // resolution takes to unwind isn't this test's concern.
    while (vi.mocked(addCaptureWorklet).mock.calls.length === 0) {
      await Promise.resolve();
    }

    recorder.cancel();
    expect(recorder.getState()).toBe("idle");

    resolveWorklet();
    await startPromise;

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(recorder.getState()).toBe("idle");

    delete (globalThis as { window?: unknown }).window;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });
});
