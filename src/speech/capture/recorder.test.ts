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
import { Recorder, hangoverForReference } from "./recorder.js";
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

  it("a brief noise blip during the hangover window does not reset the countdown", () => {
    // Reported symptom: background noise loud enough to cross the (necessarily
    // noise-tolerant) threshold kept extending the wait well past when the
    // learner actually stopped talking. Root cause: any single ~3ms worklet
    // frame above threshold used to reset the countdown unconditionally.
    const { t, onAutoStop } = makeRecorder(1000);
    let now = feed(t, 0, [
      { level: -60, durationMs: 300 },
      { level: -20, durationMs: 500 }, // speech ends at now=800
    ]);
    now = feed(t, now, [{ level: -60, durationMs: 400 }]); // real trailing silence
    now = feed(t, now, [{ level: -40, durationMs: 40 }]); // blip: above threshold, but only 40ms — under MIN_RENEWED_SPEECH_MS
    expect(onAutoStop).not.toHaveBeenCalled();

    // If the blip had reset the countdown, this would not be enough more
    // silence to cross a fresh 1000ms window from here.
    feed(t, now, [{ level: -60, durationMs: 600 }]); // total since speech ended (800): 400+40+600 = 1040ms
    expect(onAutoStop).toHaveBeenCalledTimes(1);
  });

  it("genuine renewed speech during the hangover window does reset the countdown", () => {
    // The companion test: the fix above must not overcorrect into cutting
    // learners off mid-sentence, which the code's own comments call out as
    // the worse failure mode than waiting longer.
    const { t, onAutoStop } = makeRecorder(1000);
    let now = feed(t, 0, [
      { level: -60, durationMs: 300 },
      { level: -20, durationMs: 500 }, // first utterance ends at now=800
    ]);
    now = feed(t, now, [{ level: -60, durationMs: 400 }]); // a mid-sentence pause
    now = feed(t, now, [{ level: -20, durationMs: 200 }]); // real continued speech, ends at now=1400
    expect(onAutoStop).not.toHaveBeenCalled();

    now = feed(t, now, [{ level: -60, durationMs: 600 }]); // 600ms since speech resumed — not enough yet
    expect(onAutoStop).not.toHaveBeenCalled();

    feed(t, now, [{ level: -60, durationMs: 500 }]); // 1100ms since speech last stopped (1400) — crosses it
    expect(onAutoStop).toHaveBeenCalledTimes(1);
  });

  it("a run right at MIN_RENEWED_SPEECH_MS counts; just under it does not", () => {
    // Just under the cutoff — same shape as the blip test above.
    {
      const { t, onAutoStop } = makeRecorder(1000);
      let now = feed(t, 0, [
        { level: -60, durationMs: 300 },
        { level: -20, durationMs: 500 }, // speech ends at now=800
      ]);
      now = feed(t, now, [{ level: -60, durationMs: 200 }]);
      now = feed(t, now, [{ level: -40, durationMs: 60 }]); // 60ms run — under the 80ms cutoff
      feed(t, now, [{ level: -60, durationMs: 940 }]); // total since 800: 200+60+940 = 1200ms
      expect(onAutoStop).toHaveBeenCalledTimes(1); // fired off the original speech end, unaffected by the run
    }

    // At the cutoff — this run is long enough to count as renewed speech.
    {
      const { t, onAutoStop } = makeRecorder(1000);
      let now = feed(t, 0, [
        { level: -60, durationMs: 300 },
        { level: -20, durationMs: 500 }, // speech ends at now=800
      ]);
      now = feed(t, now, [{ level: -60, durationMs: 200 }]);
      now = feed(t, now, [{ level: -40, durationMs: 80 }]); // 80ms run — meets the cutoff, counts as renewed speech
      now = feed(t, now, [{ level: -60, durationMs: 980 }]); // 980ms since the run ended — not enough yet
      expect(onAutoStop).not.toHaveBeenCalled();
      feed(t, now, [{ level: -60, durationMs: 40 }]); // 1020ms since the run ended — crosses it
      expect(onAutoStop).toHaveBeenCalledTimes(1);
    }
  });

  it("several short noise blips in a row do not cumulatively reset the countdown", () => {
    const { t, onAutoStop } = makeRecorder(1000);
    let now = feed(t, 0, [
      { level: -60, durationMs: 300 },
      { level: -20, durationMs: 500 }, // speech ends at now=800
    ]);
    // Three separate 40ms blips, each individually under MIN_RENEWED_SPEECH_MS,
    // separated by silence — must not count individually, and must not add up
    // across the gaps between them either (the run has to reset to zero on
    // every below-threshold frame, not merely fail to reach the cutoff once).
    for (let i = 0; i < 3; i++) {
      now = feed(t, now, [{ level: -60, durationMs: 60 }]);
      now = feed(t, now, [{ level: -40, durationMs: 40 }]);
    }
    now = feed(t, now, [{ level: -60, durationMs: 620 }]); // total since 800: 300 (blips+gaps) + 620 = 920ms
    expect(onAutoStop).not.toHaveBeenCalled();

    feed(t, now, [{ level: -60, durationMs: 100 }]); // total since 800: 1020ms
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

  it("ignores a loud startup transient, which is the bug that shipped", () => {
    /**
     * The regression this file's header claims to guard, actually reproduced.
     *
     * The test above feeds a *quiet* frame during the grace period and a loud
     * one after it — the opposite order to a startup transient — so the later
     * frame overwrites the earlier one either way and the grace period is
     * never what makes the assertion pass. A mutation sweep showed that:
     * flattening the guard to `||`, which bypasses the grace period entirely,
     * left every calibration test green.
     *
     * The real shape is a worklet/AudioContext startup pop that is *louder*
     * than the speech which follows. `peakSpeechDb` only ever rises, so one
     * such frame pins the threshold above the learner's actual voice for the
     * rest of the take: speech never registers as speech, the endpointer never
     * releases, and the take runs to MAX_SECONDS. Every observed TOO_LONG
     * failure landed within a few hundred ms of MAX_SECONDS, on the first take
     * of a session, across several browsers.
     *
     * With the guard the peak comes from the speech (-40), so the floor side
     * wins at -58 and speech at -40 sits above it. Without it the peak comes
     * from the pop (-2), the threshold is pinned at the -30 ceiling, and
     * speech at -40 is below it — inaudible to the endpointer.
     */
    const { t } = makeRecorder();

    t.calibrateThreshold(-70, 0); // room tone, establishing a quiet floor
    t.calibrateThreshold(-2, 50); // the pop, inside the grace period
    const threshold = t.calibrateThreshold(-40, 300); // real speech, quieter

    expect(threshold).toBe(-58);
    expect(threshold).toBeLessThan(-40);
  });

  it("starts trusting the peak exactly at the end of the grace period", () => {
    // The boundary itself: a frame at 150 ms is past the grace, not inside it.
    // Inclusive on purpose — the window is for startup artefacts, and holding
    // it open one frame longer would discard real speech from a fast starter.
    const { t } = makeRecorder();
    t.calibrateThreshold(-70, 0);

    const atBoundary = t.calibrateThreshold(-20, 150);

    // fromFloor = -70 + 12 = -58; fromPeak = -20 - 28 = -48; the peak wins,
    // which it only can if the frame counted.
    expect(atBoundary).toBe(-48);
  });

  it("anchors to the loudest frame heard, not the most recent one", () => {
    /**
     * The property that makes the endpointer work in a noisy room, and the one
     * my first attempt at the test above failed to pin.
     *
     * calibrateThreshold's own comment is explicit: an absolute threshold
     * cannot separate a loud room from a soft voice, so the threshold is
     * anchored to the loudest frame actually heard. `peakSpeechDb` therefore
     * only ever rises. If it tracked the *latest* frame instead, the threshold
     * would sag as a learner trailed off at the end of a phrase — and a
     * sagging threshold means the trailing quiet reads as speech, the
     * endpointer never releases, and the take runs to the ceiling.
     *
     * Both frames here are past the grace period and they descend, which is
     * what separates "max" from "last": the peak must stay with the -20.
     */
    const { t } = makeRecorder();

    t.calibrateThreshold(-70, 0); // room tone
    t.calibrateThreshold(-20, 200); // the loudest speech of the take
    const threshold = t.calibrateThreshold(-50, 400); // trailing off

    // fromPeak = -20 - 28 = -48 beats fromFloor = -70 + 12 = -58. Had the peak
    // followed the last frame it would be -50 - 28 = -78 and the floor would
    // win at -58.
    expect(threshold).toBe(-48);
  });

  it("keeps the floor from a quiet frame while ignoring it for the peak", () => {
    /**
     * The two halves of calibrateThreshold read the same frames for opposite
     * purposes, and only the peak side has a grace period. A grace frame must
     * still lower the noise floor — discarding it there would leave the floor
     * unmeasured through the quietest part of every take, which is exactly
     * where room tone is legible.
     */
    const { t } = makeRecorder();

    t.calibrateThreshold(-70, 0); // grace: informs the floor, not the peak
    const threshold = t.calibrateThreshold(-45, 300);

    // The floor came from the grace frame: -70 + 12 = -58 beats -45 - 28 = -73.
    expect(threshold).toBe(-58);
  });
});

/**
 * How long a learner may pause before the take ends itself.
 *
 * A pure function, and the one number that decides whether someone hesitating
 * mid-phrase gets cut off. Its own comment sets the policy: longer prompts
 * earn more patience, because more words means more internal pauses and the
 * cost of waiting is far lower than the cost of truncating. Each rung of the
 * ladder is a separate `<=` that can drift on its own, and drifting down is
 * the expensive direction — a truncated take is a wasted attempt, while
 * waiting an extra 400 ms costs nothing.
 */
describe("hangoverForReference", () => {
  it("gives the shortest window only to the shortest prompts", () => {
    // Boundaries on the generous side: a two-word prompt is still short, a
    // three-word one has an internal pause to allow for.
    expect(hangoverForReference("Bonjour")).toBe(1200);
    expect(hangoverForReference("Bonne soirée")).toBe(1200);
    expect(hangoverForReference("Bonjour comment allez-vous")).toBe(1600);
  });

  it("steps up at five and at nine words", () => {
    expect(hangoverForReference("un deux trois quatre cinq")).toBe(1600);
    expect(hangoverForReference("un deux trois quatre cinq six")).toBe(2000);
    expect(hangoverForReference("un deux trois quatre cinq six sept huit neuf")).toBe(2000);
    expect(hangoverForReference("un deux trois quatre cinq six sept huit neuf dix")).toBe(2400);
  });

  it("is monotonic — a longer prompt never earns less patience", () => {
    let previous = 0;
    let phrase = "";
    for (let words = 1; words <= 15; words += 1) {
      phrase = `${phrase} mot`.trim();
      const hangover = hangoverForReference(phrase);
      expect(hangover, `${words} words`).toBeGreaterThanOrEqual(previous);
      previous = hangover;
    }
  });

  it("counts words rather than characters", () => {
    /**
     * The policy is about internal pauses, which track word count. A single
     * very long word has no internal pause to wait for, and a run of short
     * ones does.
     */
    expect(hangoverForReference("anticonstitutionnellement")).toBe(1200);
    expect(hangoverForReference("a b c d e f g h i j")).toBe(2400);
  });

  it("is not confused by the whitespace real prompts carry", () => {
    // Activity targets come from content files: leading and trailing space,
    // and double spaces after punctuation, are all realistic.
    expect(hangoverForReference("  Bonjour,  comment   allez-vous  ")).toBe(1600);
  });

  it("still returns a usable window for an empty prompt", () => {
    /**
     * Reachable: ActivityTest passes `activity?.target ?? ""` and the fixture
     * runner starts with an empty custom phrase. A zero or NaN window would
     * either end every take instantly or never end one at all.
     */
    for (const empty of ["", "   ", "\t\n"]) {
      const hangover = hangoverForReference(empty);
      expect(hangover, JSON.stringify(empty)).toBe(1200);
    }
  });

  it("stays inside the take ceiling at its most patient", () => {
    // MAX_AUDIO_SECONDS is 15. A hangover approaching that would let silence
    // consume the whole allowance before the learner finished speaking.
    expect(hangoverForReference("a b c d e f g h i j k l m n o p")).toBeLessThan(3000);
  });
});
