/**
 * R4 and R5 — the capture profile, and the honesty of what we report about it.
 *
 * R4 asks the browser to turn off all three DSP stages, and the reason is the
 * measurement: gain control flattens syllable stress, noise suppression works
 * on exactly the spectrum where phoneme identity lives. If one of these flags
 * flipped to `true`, nothing would break. Every take would still record,
 * upload and score. The scores would just quietly stop measuring the learner's
 * pronunciation and start measuring the browser's idea of a clean voice call —
 * and by then there would be a fixture's worth of numbers built on it.
 *
 * R5 is the other half. These constraints are a *request*: iOS applies voice
 * processing below the browser and may ignore all of it. So the readback has
 * to distinguish three states, not two — on, off, and "the platform did not
 * say" — because "Safari refused" and "Safari didn't tell us" are different
 * findings and the fixture analysis depends on not confusing them.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANALYSIS_CONSTRAINTS,
  acquireMicrophone,
  describeConstraint,
  readGrantedConstraints,
} from "./constraints.js";
import { CaptureError } from "./errors.js";

interface TrackStub {
  getSettings?: () => MediaTrackSettings;
  stop: () => void;
}

function track(settings?: MediaTrackSettings, stop = (): void => undefined): MediaStreamTrack {
  const t: TrackStub = { stop };
  if (settings) t.getSettings = () => settings;
  return t as unknown as MediaStreamTrack;
}

/** Enough of window/navigator/performance for acquireMicrophone to run. */
function stubEnvironment(options: {
  secure?: boolean;
  getUserMedia?: (() => Promise<MediaStream>) | undefined;
  now?: () => number;
}): void {
  vi.stubGlobal("window", { isSecureContext: options.secure ?? true });
  vi.stubGlobal("navigator", {
    mediaDevices: options.getUserMedia ? { getUserMedia: options.getUserMedia } : {},
  });
  vi.stubGlobal("performance", { now: options.now ?? ((): number => 0) });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ANALYSIS_CONSTRAINTS — R4", () => {
  it("asks for all three processing stages off", () => {
    /**
     * Pinned as literal `false`, not falsy. `undefined` would read as "off" to
     * a casual glance and mean "browser default" to getUserMedia — which is
     * on, for all three, on every platform.
     */
    const audio = ANALYSIS_CONSTRAINTS.audio as MediaTrackConstraints;

    expect(audio.echoCancellation).toBe(false);
    expect(audio.autoGainControl).toBe(false);
    expect(audio.noiseSuppression).toBe(false);
  });

  it("asks for one channel, so no downmix happens after the fact", () => {
    // R7 is mono. Requesting it at the source is better than mixing later,
    // and it is what keeps a web take comparable with a native one.
    expect((ANALYSIS_CONSTRAINTS.audio as MediaTrackConstraints).channelCount).toBe(1);
  });

  it("does not ask for video", () => {
    // A truthy video constraint would put a camera indicator on a learner's
    // screen for a pronunciation app. Nothing about that is subtle, but
    // nothing about it errors either.
    expect(ANALYSIS_CONSTRAINTS.video).toBe(false);
  });
});

describe("acquireMicrophone — refusing before asking", () => {
  it("names an insecure context rather than letting getUserMedia fail obscurely", async () => {
    /**
     * The LAN-IP case, which has actually happened on this project: a phone
     * pointed at http://<mac-mini-ip> is not a secure context, so
     * getUserMedia is unavailable and every diagnostic downstream is a red
     * herring. Named up front, it is a one-line fix instead of an afternoon.
     */
    stubEnvironment({ secure: false });

    await expect(acquireMicrophone()).rejects.toMatchObject({ code: "INSECURE_CONTEXT" });
  });

  it("reports an unsupported browser when the API is simply absent", async () => {
    stubEnvironment({ getUserMedia: undefined });

    await expect(acquireMicrophone()).rejects.toMatchObject({ code: "UNSUPPORTED_BROWSER" });
  });

  it("throws a CaptureError, not a bare Error, so the UI can map it", async () => {
    // The toast layer switches on `code`. A plain Error reaches the learner as
    // the generic "something went wrong" that tells them nothing actionable.
    stubEnvironment({ secure: false });

    await expect(acquireMicrophone()).rejects.toBeInstanceOf(CaptureError);
  });
});

describe("acquireMicrophone — distinguishing a denial from a dismissal", () => {
  /**
   * getUserMedia reports both as NotAllowedError, and the advice differs
   * completely: a dismissed prompt means "tap again", a standing block means
   * "change a browser setting". Only the timing separates them — a decision
   * that arrived in under 250ms was not made by a person.
   */
  async function denyAfter(ms: number): Promise<CaptureError> {
    let calls = 0;
    stubEnvironment({
      now: () => (calls++ === 0 ? 0 : ms),
      getUserMedia: () => Promise.reject(new DOMException("denied", "NotAllowedError")),
    });
    try {
      await acquireMicrophone();
      throw new Error("expected a rejection");
    } catch (err) {
      return err as CaptureError;
    }
  }

  it("calls an instant refusal a standing block", async () => {
    expect((await denyAfter(10)).code).toBe("PERMISSION_DENIED");
  });

  it("calls a considered refusal a dismissed prompt", async () => {
    expect((await denyAfter(3000)).code).toBe("PERMISSION_DISMISSED");
  });

  it("maps a missing device, a busy device and an unknown fault apart", async () => {
    // Four different pieces of advice for the learner. Collapsing them into
    // one generic failure is the difference between "unplug and replug" and
    // "close the other tab using your mic".
    const cases: [string, string][] = [
      ["NotFoundError", "NO_MICROPHONE"],
      ["OverconstrainedError", "NO_MICROPHONE"],
      ["NotReadableError", "DEVICE_LOST"],
      ["AbortError", "DEVICE_LOST"],
      ["SomethingNew", "UNSUPPORTED_BROWSER"],
    ];

    for (const [name, code] of cases) {
      stubEnvironment({ getUserMedia: () => Promise.reject(new DOMException("x", name)) });
      await expect(acquireMicrophone(), name).rejects.toMatchObject({ code });
    }
  });
});

describe("acquireMicrophone — a stream with no audio track", () => {
  it("stops the tracks it is about to abandon", async () => {
    /**
     * The leak that leaves the browser's recording indicator lit on a learner's
     * screen after a failure. A live MediaStream nobody holds a reference to
     * does not stop itself, and a recording light nobody can explain is worse
     * than the original error.
     */
    const stopped: string[] = [];
    const stream = {
      getAudioTracks: () => [],
      getTracks: () => [track(undefined, () => stopped.push("a")), track(undefined, () => stopped.push("b"))],
    } as unknown as MediaStream;
    stubEnvironment({ getUserMedia: () => Promise.resolve(stream) });

    await expect(acquireMicrophone()).rejects.toMatchObject({ code: "NO_MICROPHONE" });
    expect(stopped).toEqual(["a", "b"]);
  });

  it("returns the track and its readback on success", async () => {
    const audioTrack = track({ echoCancellation: false, sampleRate: 48000 });
    const stream = {
      getAudioTracks: () => [audioTrack],
      getTracks: () => [audioTrack],
    } as unknown as MediaStream;
    stubEnvironment({ getUserMedia: () => Promise.resolve(stream) });

    const acquired = await acquireMicrophone();

    expect(acquired.track).toBe(audioTrack);
    expect(acquired.granted.sampleRate).toBe(48000);
  });
});

describe("readGrantedConstraints — R5", () => {
  it("never confuses 'off' with 'not reported'", () => {
    /**
     * The distinction the whole readback exists for, and the one a `??` or a
     * `||` would silently destroy: `false` is a platform confirming it honoured
     * the request, and `"not reported"` is a platform saying nothing. Reading
     * the second as the first would let a fixture run conclude iOS respected
     * R4 when iOS never answered.
     */
    const reported = readGrantedConstraints(
      track({ echoCancellation: false, autoGainControl: false, noiseSuppression: false }),
    );
    const silent = readGrantedConstraints(track({}));

    expect(reported.echoCancellation).toBe(false);
    expect(reported.autoGainControl).toBe(false);
    expect(reported.noiseSuppression).toBe(false);
    expect(silent.echoCancellation).toBe("not reported");
    expect(silent.autoGainControl).toBe("not reported");
    expect(silent.noiseSuppression).toBe("not reported");
  });

  it("records a refused request as refused", () => {
    // iOS applying voice processing below the browser is the expected finding,
    // not a bug — but it only counts as a finding if it is recorded.
    const granted = readGrantedConstraints(track({ autoGainControl: true }));

    expect(granted.autoGainControl).toBe(true);
  });

  it("survives a platform with no getSettings at all", () => {
    // Older WebViews. Everything unknown, nothing thrown, and the take still
    // records — the readback is evidence, not a prerequisite.
    const granted = readGrantedConstraints(track());

    expect(granted).toEqual({
      echoCancellation: "not reported",
      autoGainControl: "not reported",
      noiseSuppression: "not reported",
      channelCount: "not reported",
      sampleRate: "not reported",
      deviceId: "not reported",
    });
  });

  it("keeps a numeric zero rather than treating it as absent", () => {
    // The falsy-number trap. A channelCount of 0 is a strange platform report
    // worth seeing in the export, not a value to quietly relabel as unknown.
    expect(readGrantedConstraints(track({ channelCount: 0 })).channelCount).toBe(0);
  });

  it("treats an empty deviceId as not reported, because that is what it means", () => {
    // Safari returns "" before permission is granted. Reporting "" in the
    // fixture export would look like a device whose id is the empty string.
    expect(readGrantedConstraints(track({ deviceId: "" })).deviceId).toBe("not reported");
  });

  it("ignores a value of the wrong type instead of passing it through", () => {
    // getSettings is platform-supplied and not type-checked at runtime.
    const odd = { echoCancellation: "yes", sampleRate: "48000" } as unknown as MediaTrackSettings;

    const granted = readGrantedConstraints(track(odd));

    expect(granted.echoCancellation).toBe("not reported");
    expect(granted.sampleRate).toBe("not reported");
  });
});

describe("describeConstraint", () => {
  it("says plainly when the platform overrode the request", () => {
    // This string is what a fixture operator reads on the debug panel mid-run.
    // "true" would need decoding; this does not.
    expect(describeConstraint(true)).toBe("ON (request refused)");
    expect(describeConstraint(false)).toBe("off (as requested)");
    expect(describeConstraint("not reported")).toBe("not reported");
  });

  it("does not describe silence as success", () => {
    // The one wrong answer here would be reading "not reported" as "off".
    expect(describeConstraint("not reported")).not.toBe(describeConstraint(false));
  });
});
