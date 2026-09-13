/**
 * The check, and the distinctions it exists to keep apart.
 *
 * Every assertion here is a screen a learner would otherwise be sent to
 * wrongly. Two matter more than the rest:
 *
 *  - **Silence is not a low score.** A flat signal means muted or wrongly
 *    routed, and neither is fixed by speaking louder — which is what every
 *    "too quiet" screen advises. Ranking silence at the bottom of the same
 *    scale sends those learners to try harder at a device that is not
 *    listening.
 *  - **An insecure address is not a denied permission.** There is nothing to
 *    grant over `http`, so classifying it as denied would march a learner
 *    through their settings to fix something that is not broken, and leave
 *    them believing they broke it.
 */

import { describe, expect, it } from "vitest";
import {
  MIN_CHECK_SECONDS,
  availabilityFrom,
  verdictFor,
  type CheckMeasurement,
  type Environment,
} from "./micCheck.js";

function env(over: Partial<Environment> = {}): Environment {
  return {
    secureContext: true,
    hasMediaDevices: true,
    inputCount: 1,
    permission: "granted",
    ...over,
  };
}

function measured(over: Partial<CheckMeasurement> = {}): CheckMeasurement {
  return {
    snrDb: 25,
    speechDbfs: -16,
    roomDbfs: -41,
    clippedFraction: 0,
    seconds: 5,
    silent: false,
    ...over,
  };
}

describe("what the environment allows", () => {
  it("is available on a secure page with a granted microphone", () => {
    expect(availabilityFrom(env())).toEqual({ state: "available" });
  });

  /**
   * The ordering that matters most. An insecure page has no permission worth
   * reporting and usually no `mediaDevices` at all, so asking about permission
   * first classifies every LAN-address visit as *denied*.
   */
  it("reports an insecure address as such, whatever the permission says", () => {
    for (const permission of ["denied", "prompt", "granted", "unknown"] as const) {
      expect(availabilityFrom(env({ secureContext: false, permission }))).toEqual({
        state: "insecure",
      });
    }
  });

  it("treats a browser with no getUserMedia the same way", () => {
    expect(availabilityFrom(env({ hasMediaDevices: false }))).toEqual({ state: "insecure" });
  });

  it("reports a refusal as denied, since the page cannot ask again", () => {
    expect(availabilityFrom(env({ permission: "denied" }))).toEqual({ state: "denied" });
  });

  it("reports no hardware once permission is settled and the list is empty", () => {
    expect(availabilityFrom(env({ permission: "granted", inputCount: 0 }))).toEqual({
      state: "no-hardware",
    });
  });

  /**
   * Null is not zero, and the difference is a screen. Before permission,
   * `enumerateDevices` returns label-less entries and can legitimately report
   * none — calling that "no hardware" tells a learner with a working
   * microphone that their device has none.
   */
  it("does not call an unenumerated device list 'no hardware'", () => {
    expect(availabilityFrom(env({ permission: "prompt", inputCount: null }))).toEqual({
      state: "available",
    });
    expect(availabilityFrom(env({ permission: "prompt", inputCount: 0 }))).toEqual({
      state: "available",
    });
  });
});

describe("the verdict", () => {
  it("passes a signal well clear of the room", () => {
    expect(verdictFor(measured()).verdict).toBe("good");
  });

  it("calls a thin margin quiet rather than good", () => {
    expect(verdictFor(measured({ snrDb: 8 })).verdict).toBe("quiet");
  });

  /**
   * Ten dB of headroom above the recorder's own gate. A check that passed at
   * exactly the gate would tell a learner their device is fine while sitting
   * on the line that rejects takes, so every door closing lands the other
   * side of it.
   */
  it("keeps a margin above the gate that rejects takes", () => {
    // 10 dB is the recorder's SNR gate; anything from there to 20 is workable
    // but not something to call good.
    expect(verdictFor(measured({ snrDb: 10 })).verdict).toBe("quiet");
    expect(verdictFor(measured({ snrDb: 19.9 })).verdict).toBe("quiet");
    expect(verdictFor(measured({ snrDb: 20 })).verdict).toBe("good");
  });

  it("reports silence as its own answer, not as the worst score", () => {
    expect(verdictFor(measured({ silent: true })).verdict).toBe("silent");
    expect(verdictFor(measured({ snrDb: 0 })).verdict).toBe("silent");
    expect(verdictFor(measured({ snrDb: -3 })).verdict).toBe("silent");
  });

  /**
   * The case SNR is blind to. A hard-clipped take measures a superb ratio —
   * 37.8 dB on a real one — because clipping lifts the speech percentile and
   * leaves the floor alone. Reading only SNR would call the worst possible
   * audio excellent, and the fix for clipping is the opposite of the advice a
   * quiet verdict gives.
   */
  it("refuses to call a clipped take good, however clean its ratio looks", () => {
    const clipped = measured({ snrDb: 37.8, clippedFraction: 0.02 });

    expect(verdictFor(clipped).verdict).not.toBe("good");
    expect(verdictFor(clipped).clipping).toBe(true);
  });

  it("reports clipping alongside a passing verdict when there is none", () => {
    expect(verdictFor(measured()).clipping).toBe(false);
  });

  /**
   * Length is reported, not folded into the verdict. A short take is not a bad
   * device — it is not yet an answer — and the screen shows progress toward
   * four seconds rather than a premature judgement.
   */
  it("says whether the take was long enough to judge", () => {
    expect(verdictFor(measured({ seconds: MIN_CHECK_SECONDS - 0.1 })).conclusive).toBe(false);
    expect(verdictFor(measured({ seconds: MIN_CHECK_SECONDS })).conclusive).toBe(true);
  });

  it("reports the margin the learner is shown, rounded", () => {
    expect(verdictFor(measured({ snrDb: 24.6 })).marginDb).toBe(25);
    // Silence has no margin to report, rather than a negative one.
    expect(verdictFor(measured({ silent: true, snrDb: -5 })).marginDb).toBe(0);
  });
});
