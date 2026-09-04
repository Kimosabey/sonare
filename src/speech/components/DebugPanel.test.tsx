// @vitest-environment jsdom

/**
 * T15/FR-25 — the panel that has to be on every device during the fixture run.
 *
 * This is not a developer convenience. R5 says the whole POC turns on knowing
 * *what iOS actually granted*, and this is the only place a recording's own
 * evidence becomes visible — which is why it ships instead of hiding behind a
 * build flag. During a fixture session it is read on someone else's phone, in
 * the moment, to decide whether a surprising score is the scorer or the
 * device.
 *
 * The load-bearing distinction is three-state, not two: "not reported" is the
 * browser declining to say, and it is a different fact from a constraint being
 * off. Collapsing them would let a fixture run conclude iOS honoured R4 when
 * iOS never answered — and that conclusion is the deliverable, so the error
 * would not be a bug report, it would be a finding.
 */

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DebugPanel } from "./DebugPanel.js";
import type { CaptureResult, GrantedConstraints } from "../capture/types.js";
import type { PronunciationResult } from "../scoring/types.js";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

function granted(overrides: Partial<GrantedConstraints> = {}): GrantedConstraints {
  return {
    echoCancellation: false,
    autoGainControl: false,
    noiseSuppression: false,
    channelCount: 1,
    sampleRate: 48000,
    deviceId: "abcdef0123456789abcdef",
    ...overrides,
  } as GrantedConstraints;
}

function capture(overrides: Partial<CaptureResult> = {}): CaptureResult {
  return {
    durationSeconds: 2.345,
    snrDb: 18.72,
    peakDbfs: -14.3,
    endpoint: { autoStopped: true, thresholdDb: -42.37, noiseFloorDb: -63.42 },
    ...overrides,
  } as CaptureResult;
}

function rowValue(label: string): string {
  const row = [...document.querySelectorAll("tr")].find(
    (tr) => tr.querySelector("td")?.textContent === label,
  );
  if (!row) throw new Error(`no row labelled "${label}"`);
  return row.querySelectorAll("td")[1]?.textContent ?? "";
}

function open(props: Partial<Parameters<typeof DebugPanel>[0]> = {}) {
  render(
    <DebugPanel
      granted={null}
      contextSampleRate={null}
      capture={null}
      result={null}
      {...props}
    />,
  );
}

beforeEach(() => {
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: IPHONE });
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
});

afterEach(cleanup);

describe("R5 — three states, not two", () => {
  it("distinguishes a refused request from an honoured one", () => {
    /**
     * The finding the fixture exists to produce. iOS applies voice processing
     * below the browser and may ignore the request entirely — that is a
     * platform property, not a bug, and it only counts as a finding if it is
     * visible on the device at the time.
     */
    open({ granted: granted({ autoGainControl: true, noiseSuppression: false }) });

    expect(rowValue("gain control")).toBe("ON (request refused)");
    expect(rowValue("noise suppression")).toBe("off (as requested)");
  });

  it("never renders silence as success", () => {
    /**
     * The one wrong answer available here. Reading "not reported" as "off"
     * would let a run conclude iOS respected R4 when iOS said nothing — and
     * since that conclusion is the deliverable, the mistake would arrive as a
     * finding rather than as a bug.
     */
    open({ granted: granted({ echoCancellation: "not reported" }) });

    expect(rowValue("echo cancellation")).toBe("not reported");
    expect(rowValue("echo cancellation")).not.toBe(rowValue("noise suppression"));
  });

  it("explains what 'not reported' means, for whoever is reading it on a phone", () => {
    // The panel is read by an operator mid-session, not by whoever wrote it.
    // Without this line, "not reported" invites exactly the wrong reading.
    open({ granted: granted() });

    expect(screen.getByText(/did not tell us — expected on Safari/)).toBeInTheDocument();
    expect(screen.getByText(/not the same as the constraint being off/)).toBeInTheDocument();
  });
});

describe("the capture's own measurements", () => {
  it("shows what was measured, at a precision that can be compared", () => {
    /**
     * These are the numbers that separate "the room was noisy" from "the
     * scorer could not match it". Rounding SNR to whole dB would make two
     * takes 0.4 dB apart look identical.
     */
    open({ capture: capture() });

    expect(rowValue("duration")).toBe("2.35 s");
    expect(rowValue("SNR")).toBe("18.7 dB");
    expect(rowValue("peak")).toBe("-14.3 dBFS");
  });

  it("says whether the take ended itself or was tapped", () => {
    // Distinguishes "auto-stop cut me off" from "I stopped early", which are
    // opposite explanations for a truncated phrase.
    open({ capture: capture({ endpoint: { autoStopped: true, thresholdDb: -42, noiseFloorDb: -60 } } as never) });
    expect(rowValue("ended by")).toBe("auto (silence)");

    cleanup();
    open({ capture: capture({ endpoint: { autoStopped: false, thresholdDb: -42, noiseFloorDb: -60 } } as never) });
    expect(rowValue("ended by")).toBe("tap");
  });

  it("shows the adaptive threshold and the floor it came from", () => {
    /**
     * The endpointer's threshold is derived from the measured noise floor, so
     * seeing both together is what makes a premature auto-stop explainable
     * instead of mysterious — a noisy room raises the floor, the threshold
     * follows, and a quiet speaker falls below it.
     */
    open({ capture: capture() });

    expect(rowValue("speech threshold")).toBe("-42.4 dBFS");
    expect(rowValue("noise floor")).toBe("-63.4 dBFS");
  });

  it("shows a dash for a floor that was never established", () => {
    // Distinct from a floor of 0 dBFS, which would be a broken measurement
    // rather than a missing one.
    open({ capture: capture({ endpoint: { autoStopped: true, thresholdDb: -42, noiseFloorDb: null } } as never) });

    expect(rowValue("noise floor")).toBe("—");
  });

  it("keeps a floor of zero visible rather than treating it as absent", () => {
    // `== null` and not a truthiness check: 0 dBFS is a real, alarming value
    // and hiding it would hide the alarm.
    open({ capture: capture({ endpoint: { autoStopped: true, thresholdDb: -42, noiseFloorDb: 0 } } as never) });

    expect(rowValue("noise floor")).toBe("0.0 dBFS");
  });
});

describe("the device", () => {
  it("shows the parsed device and the raw agent", () => {
    // The parsed line is readable at a glance; the raw string is what gets
    // pasted into a note, and one does not replace the other.
    open();

    expect(rowValue("device")).toBe("iPhone 17.5.1 · Safari 17");
    expect(rowValue("user agent")).toBe(IPHONE);
  });

  it("warns when the context is insecure", () => {
    // The reason a phone on a LAN address cannot record. Without this row it
    // presents as a broken microphone, which has cost real time here.
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });

    open();

    expect(rowValue("secure context")).toBe("NO — mic will not open");
  });

  it("shows the device's own rate next to what we send", () => {
    /**
     * The pair is the point: R7 fixes the upload at 16 kHz, and a 48 kHz
     * device rate beside it is what shows the resampler ran. Two different
     * numbers here is correct, and a fixture operator needs to know that
     * before wondering about it.
     */
    open({ contextSampleRate: 48000, granted: granted({ sampleRate: 48000 }) });

    expect(rowValue("context rate")).toBe("48000 Hz");
    expect(rowValue("mic sample rate")).toBe("48000");
    expect(rowValue("sent as")).toBe("16000 Hz mono PCM16");
  });

  it("truncates a long device id but keeps a recognisable one", () => {
    /**
     * A raw deviceId is a 64-character fingerprint-grade hash and it is being
     * displayed on a phone. Twelve characters is enough to tell two
     * microphones apart across takes, which is all it is for.
     */
    open({ granted: granted({ deviceId: "abcdef0123456789abcdef" }) });

    expect(rowValue("mic id")).toBe("abcdef012345");
  });

  it("keeps the meaningful ids intact", () => {
    // "default" and "not reported" are words, not hashes; slicing them would
    // turn them into nonsense.
    open({ granted: granted({ deviceId: "default" }) });
    expect(rowValue("mic id")).toBe("default");

    cleanup();
    open({ granted: granted({ deviceId: "not reported" }) });
    expect(rowValue("mic id")).toBe("not reported");
  });
});

describe("the provider", () => {
  it("names the provider and its model version when reported", () => {
    // R12 keeps a second provider possible. When one arrives, which one
    // produced a given score has to be legible from the record.
    open({ result: { provider: "azure", modelVersion: "2024-11-15" } as PronunciationResult });

    expect(rowValue("provider")).toBe("azure");
    expect(rowValue("model version")).toBe("2024-11-15");
  });

  it("says 'not reported' for an absent model version", () => {
    /**
     * A blank here would read as "no model", and the version is the one thing
     * that would explain a whole session's scores shifting between two
     * fixture days.
     */
    open({ result: { provider: "azure" } as PronunciationResult });

    expect(rowValue("model version")).toBe("not reported");
  });
});

describe("before anything has been recorded", () => {
  it("shows dashes rather than zeros", () => {
    /**
     * A duration of "0.00 s" and an SNR of "0.0 dB" would look like a
     * measurement of silence. A dash says there is no measurement, which is a
     * different claim and the true one.
     */
    open();

    for (const label of ["duration", "SNR", "peak", "ended by", "speech threshold", "mic id"]) {
      expect(rowValue(label), label).toBe("—");
    }
  });

  it("still shows what is knowable without a recording", () => {
    // Device, agent and secure context are all available on load, and the
    // last of those is the one worth checking before a session starts.
    open();

    expect(rowValue("device")).toBe("iPhone 17.5.1 · Safari 17");
    expect(rowValue("secure context")).toBe("yes");
  });
});

describe("shape", () => {
  it("starts collapsed, since the prompt is what the learner needs", () => {
    open();

    expect(document.querySelector("details")).not.toHaveAttribute("open");
    expect(screen.getByText("Debug — what this device granted")).toBeInTheDocument();
  });

  it("keeps the table scrollable, because a user agent is 150 characters", () => {
    // This panel renders on the phone whose agent string it is displaying.
    open();

    expect(document.querySelector(".scroll-x")).toBeInTheDocument();
  });
});
