/**
 * The gate that decides whether a take is sent at all — and it had no tests.
 *
 * T10 refuses to spend a provider call, and one of a learner's three tries, on
 * audio that will produce a meaningless score. Getting it wrong is expensive
 * in both directions and silent in both: too strict and a learner who spoke
 * perfectly well is refused and never finds out why the room was the problem;
 * too loose and they burn an attempt to be told "no speech recognised" after
 * speaking clearly.
 *
 * A mutation sweep found the whole condition unasserted — including the flag
 * half, which recorder.ts documents as existing so a fixture run can keep a
 * raw take either way. Flattening it to `||` refuses *every* take.
 *
 * Drives a real capture through the fake audio graph the sibling scope tests
 * use, feeding frames into the worklet port exactly as the worklet would.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TARGET_SAMPLE_RATE } from "./resample.js";

const acquireMicrophone = vi.fn();

vi.mock("./constraints.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./constraints.js")>();
  return { ...actual, acquireMicrophone: () => acquireMicrophone() as never };
});
vi.mock("./worklet.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./worklet.js")>();
  return { ...actual, addCaptureWorklet: () => Promise.resolve() };
});

/** The port the recorder installs its frame handler on. */
let port: { onmessage: ((e: { data: Float32Array }) => void) | null; postMessage: () => void };

class FakeAudioContext {
  state = "running";
  sampleRate = TARGET_SAMPLE_RATE;
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

function fakeTrack() {
  return {
    stop: vi.fn(),
    getSettings: () => ({}),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    readyState: "live",
    enabled: true,
  } as unknown as MediaStreamTrack;
}

/**
 * `seconds` of audio whose speech frames sit at `speech` and whose room frames
 * sit at `noise`, alternating on the analyser's own 20 ms window — the same
 * construction snr.test.ts uses, so the SNR these produce is the SNR that
 * module measures.
 */
function take(seconds: number, speech: number, noise: number): Float32Array {
  const n = Math.round(TARGET_SAMPLE_RATE * seconds);
  const out = new Float32Array(n);
  const frame = Math.round((TARGET_SAMPLE_RATE * 20) / 1000);
  for (let i = 0; i < n; i += 1) {
    const loud = Math.floor(i / frame) % 2 === 0;
    out[i] = (loud ? speech : noise) * Math.sin((2 * Math.PI * 220 * i) / TARGET_SAMPLE_RATE);
  }
  return out;
}

/** Records a take and returns whatever stop() did. */
async function record(
  options: Record<string, unknown>,
  audio: Float32Array,
): Promise<{ ok: true; snrDb: number } | { ok: false; code: string }> {
  const { Recorder } = await import("./recorder.js");
  const recorder = new Recorder({ autoStop: false, ...options }, {});
  await recorder.start({ gesture: true } as never);

  // Deliver the audio the way the worklet does: in 128-sample quanta.
  for (let offset = 0; offset < audio.length; offset += 128) {
    port.onmessage?.({ data: audio.slice(offset, offset + 128) });
  }

  try {
    const result = await recorder.stop();
    return { ok: true, snrDb: result.snrDb };
  } catch (err) {
    return { ok: false, code: (err as { code: string }).code };
  } finally {
    recorder.dispose();
  }
}

beforeEach(() => {
  vi.resetModules();
  port = { onmessage: null, postMessage: vi.fn() };
  const track = fakeTrack();
  acquireMicrophone.mockResolvedValue({
    stream: { getTracks: () => [track] } as unknown as MediaStream,
    track,
    granted: null,
  } as never);
  (globalThis as { window?: unknown }).window = {
    AudioContext: FakeAudioContext,
    isSecureContext: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode = class {
    port = port;
    connect = vi.fn();
    disconnect = vi.fn();
  };
  (globalThis as { document?: unknown }).document = {
    visibilityState: "visible",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
});

afterEach(() => {
  vi.clearAllMocks();
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode;
  delete (globalThis as { document?: unknown }).document;
});

describe("the SNR gate — both halves of the condition", () => {
  it("refuses a take too quiet to produce a meaningful score", async () => {
    /**
     * The reason the gate exists. Sending this would spend a provider call and
     * one of three tries to be told "no speech recognised", which reads to the
     * learner as a verdict on their pronunciation rather than on their room.
     */
    const outcome = await record({ enforceSnrGate: true, minSnrDb: 10 }, take(2, 0.02, 0.014));

    expect(outcome).toMatchObject({ ok: false, code: "SNR_TOO_LOW" });
  });

  it("accepts a take that is clearly audible", async () => {
    // Real takes on this project measured 12.8–33 dB and scored 93–99. A gate
    // that refused those would refuse the product.
    const outcome = await record({ enforceSnrGate: true, minSnrDb: 10 }, take(2, 0.25, 0.02));

    expect(outcome.ok).toBe(true);
  });

  it("sends the take anyway when the gate is switched off", async () => {
    /**
     * The flag half, and the one a `&&` → `||` mutation destroys: with the
     * condition flattened, every take is refused regardless of either input.
     * recorder.ts documents this flag as existing so a fixture run can keep the
     * raw take either way — PRD §8 measures what the scorer does, which
     * requires the scorer to see the audio.
     */
    const outcome = await record({ enforceSnrGate: false, minSnrDb: 10 }, take(2, 0.02, 0.014));

    expect(outcome.ok).toBe(true);
  });

  it("still sends a good take when the gate is switched off", async () => {
    // Switching the gate off must not become a different gate.
    const outcome = await record({ enforceSnrGate: false }, take(2, 0.25, 0.02));

    expect(outcome.ok).toBe(true);
  });

  it("honours a raised threshold", async () => {
    // The threshold is a parameter, not a constant, so it has to be read.
    const audio = take(2, 0.1, 0.02);
    const lenient = await record({ enforceSnrGate: true, minSnrDb: 5 }, audio);
    const strict = await record({ enforceSnrGate: true, minSnrDb: 60 }, audio);

    expect(lenient.ok).toBe(true);
    expect(strict).toMatchObject({ ok: false, code: "SNR_TOO_LOW" });
  });

  it("reports the measured SNR on a take it accepted", async () => {
    /**
     * The figure has to survive into the result, because it is what
     * useCaptureToasts reads to choose between "try again a little louder" and
     * "we heard you clearly, try it slower" on an indeterminate score.
     */
    const outcome = await record({ enforceSnrGate: true, minSnrDb: 10 }, take(2, 0.25, 0.02));

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.snrDb).toBeGreaterThan(10);
  });
});

describe("the duration guards, which run before the SNR work", () => {
  it("refuses a stray tap fast and cheap", async () => {
    // FR-11, and checked first on purpose: analysing 80 ms of audio to
    // discover it is 80 ms of audio is work nobody needs.
    const outcome = await record({ minSeconds: 0.3 }, take(0.08, 0.25, 0.02));

    expect(outcome).toMatchObject({ ok: false, code: "TOO_SHORT" });
  });

  it("refuses a take past the ceiling", async () => {
    const outcome = await record({ minSeconds: 0.3, maxSeconds: 1 }, take(2, 0.25, 0.02));

    expect(outcome).toMatchObject({ ok: false, code: "TOO_LONG" });
  });

  it("checks duration before SNR, so a short quiet tap reads as short", async () => {
    /**
     * Both guards would fire on this audio. Order decides which reason the
     * learner is given, and "that was too short" is actionable where "too
     * quiet" would send them to move rooms over a mis-tap.
     */
    const outcome = await record({ enforceSnrGate: true, minSnrDb: 10, minSeconds: 0.3 }, take(0.1, 0.02, 0.014));

    expect(outcome).toMatchObject({ ok: false, code: "TOO_SHORT" });
  });
});
