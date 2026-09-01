/**
 * Regression coverage for the endpointer math in recorder.ts — the part of
 * the capture pipeline with no automated coverage before this. One case
 * here (the startup-transient test) is a direct regression guard for a bug
 * that already shipped once: see calibrateThreshold()'s own comment on why
 * PEAK_CALIBRATION_GRACE_MS exists — every observed TOO_LONG failure landed
 * within a few hundred ms of MAX_SECONDS on the first take of a session,
 * which was traced to exactly the failure this test reproduces.
 *
 * trackEndpoint()/calibrateThreshold() are private — accessed here through a
 * narrow structural cast (never `any`: src/speech/** forbids it, see
 * eslint.config.js) rather than widening the production API just for tests.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Recorder } from "./recorder.js";
import { TARGET_SAMPLE_RATE } from "./resample.js";

// The constructor registers a visibilitychange listener (for the
// backgrounding/interruption handling) — stub the two calls it needs rather
// than pull in a DOM environment for what is otherwise pure endpointing math.
beforeAll(() => {
  globalThis.document = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as Document;
});

interface TestableRecorder {
  trackEndpoint(level: number, now: number): void;
  calibrateThreshold(level: number, elapsedMs: number): number;
  captureStartedAt: number;
  sampleCount: number;
}

function testable(recorder: Recorder): TestableRecorder {
  return recorder as unknown as TestableRecorder;
}

function makeRecorder(silenceHangoverMs = 1000) {
  const onAutoStop = vi.fn();
  const recorder = new Recorder({ autoStop: true, silenceHangoverMs }, { onAutoStop });
  const t = testable(recorder);
  t.captureStartedAt = 0;
  // trackEndpoint's min-duration guard reads sampleCount / contextRate — with
  // no real AudioContext behind this recorder, contextRate falls back to
  // TARGET_SAMPLE_RATE. Seed enough "captured" samples that the guard never
  // blocks these tests, since duration gating isn't what's under test here.
  t.sampleCount = TARGET_SAMPLE_RATE * 5;
  return { t, onAutoStop };
}

/** Feeds a sequence of constant-level phases, one frame every stepMs. */
function feed(
  t: TestableRecorder,
  startAt: number,
  phases: Array<{ level: number; durationMs: number }>,
  stepMs = 20,
): number {
  let now = startAt;
  for (const { level, durationMs } of phases) {
    for (let elapsed = 0; elapsed < durationMs; elapsed += stepMs) {
      now += stepMs;
      t.trackEndpoint(level, now);
    }
  }
  return now;
}

describe("Recorder endpointing", () => {
  it("does not fire onAutoStop while the learner is still speaking", () => {
    const { t, onAutoStop } = makeRecorder(1000);
    feed(t, 0, [
      { level: -60, durationMs: 300 }, // room tone, calibrates the floor
      { level: -20, durationMs: 500 }, // speech, well above threshold
    ]);
    expect(onAutoStop).not.toHaveBeenCalled();
  });

  it("does not fire until trailing silence reaches the configured hangover", () => {
    const { t, onAutoStop } = makeRecorder(1000);
    let now = feed(t, 0, [
      { level: -60, durationMs: 300 },
      { level: -20, durationMs: 500 },
    ]);
    now = feed(t, now, [{ level: -60, durationMs: 900 }]); // short of 1000ms
    expect(onAutoStop).not.toHaveBeenCalled();

    feed(t, now, [{ level: -60, durationMs: 200 }]); // crosses 1000ms
    expect(onAutoStop).toHaveBeenCalledTimes(1);
  });

  it("a loud startup transient within the calibration grace period does not permanently raise the threshold", () => {
    // Without PEAK_CALIBRATION_GRACE_MS, a click this loud at capture start
    // would anchor peakSpeechDb near 0 dBFS, pushing the threshold up near
    // -28 dBFS — above this test's -35 dBFS speech, which would then never
    // register as speech and onAutoStop would never fire.
    const { t, onAutoStop } = makeRecorder(1000);
    const now = feed(t, 0, [
      { level: 0, durationMs: 40 }, // the transient, inside the grace window
      { level: -60, durationMs: 100 }, // room tone
      { level: -35, durationMs: 500 }, // moderate real speech
    ]);
    expect(onAutoStop).not.toHaveBeenCalled();

    feed(t, now, [{ level: -60, durationMs: 1100 }]);
    expect(onAutoStop).toHaveBeenCalledTimes(1);
  });
});

describe("Recorder threshold calibration", () => {
  it("anchors to the loudest frame heard once past the calibration grace period", () => {
    const { t } = makeRecorder();
    t.calibrateThreshold(-70, 0); // within the grace period — ignored for peak
    const threshold = t.calibrateThreshold(-20, 200); // past it — sets the peak
    // fromFloor = -70 + 12 = -58; fromPeak = -20 - 28 = -48; the higher wins.
    expect(threshold).toBe(-48);
  });

  it("clamps to the ceiling for an extremely loud room", () => {
    const { t } = makeRecorder();
    t.calibrateThreshold(-60, 0);
    const threshold = t.calibrateThreshold(0, 200);
    expect(threshold).toBe(-30);
  });

  it("clamps to the floor for an extremely quiet room", () => {
    const { t } = makeRecorder();
    t.calibrateThreshold(-74, 0);
    const threshold = t.calibrateThreshold(-74, 200);
    expect(threshold).toBe(-58);
  });
});
