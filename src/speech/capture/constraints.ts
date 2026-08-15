/**
 * T4/FR-01 — the analysis capture profile.
 *
 * R4: all three DSP stages off. Browser voice processing removes exactly the
 * spectral detail phoneme scoring reads — gain control flattens syllable
 * stress, noise suppression operates on the spectrum where phoneme identity
 * lives.
 *
 * These are a *request*. iOS applies voice processing at the audio session
 * level, below the browser, and may ignore all of it. That is a platform
 * property, not a bug — which is why we read back what was granted (R5) and
 * let the fixture measure whether it matters.
 */

import { captureError, fromGetUserMediaError } from "./errors.js";
import type { GrantedConstraints } from "./types.js";

export const ANALYSIS_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: false,
    autoGainControl: false,
    noiseSuppression: false,
    channelCount: 1,
  },
  video: false,
};

/** A prompt answered faster than this was almost certainly a standing block. */
const INSTANT_DECISION_MS = 250;

export interface AcquiredMicrophone {
  stream: MediaStream;
  track: MediaStreamTrack;
  granted: GrantedConstraints;
}

export async function acquireMicrophone(): Promise<AcquiredMicrophone> {
  if (typeof window === "undefined" || !window.isSecureContext) {
    throw captureError("INSECURE_CONTEXT", "getUserMedia requires a secure context");
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw captureError("UNSUPPORTED_BROWSER", "navigator.mediaDevices.getUserMedia is unavailable");
  }

  const askedAt = performance.now();
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(ANALYSIS_CONSTRAINTS);
  } catch (err) {
    throw fromGetUserMediaError(err, performance.now() - askedAt < INSTANT_DECISION_MS);
  }

  const track = stream.getAudioTracks()[0];
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    throw captureError("NO_MICROPHONE", "stream contained no audio track");
  }

  return { stream, track, granted: readGrantedConstraints(track) };
}

/**
 * R5/FR-04. Absent keys become "not reported" rather than a default, because
 * "Safari didn't tell us" and "Safari told us it's off" are different facts and
 * the fixture analysis depends on not confusing them.
 */
export function readGrantedConstraints(track: MediaStreamTrack): GrantedConstraints {
  const settings: MediaTrackSettings = typeof track.getSettings === "function" ? track.getSettings() : {};

  const bool = (key: keyof MediaTrackSettings): boolean | "not reported" => {
    const value = settings[key];
    return typeof value === "boolean" ? value : "not reported";
  };
  const num = (key: keyof MediaTrackSettings): number | "not reported" => {
    const value = settings[key];
    return typeof value === "number" ? value : "not reported";
  };
  const str = (key: keyof MediaTrackSettings): string | "not reported" => {
    const value = settings[key];
    return typeof value === "string" && value ? value : "not reported";
  };

  return {
    echoCancellation: bool("echoCancellation"),
    autoGainControl: bool("autoGainControl"),
    noiseSuppression: bool("noiseSuppression"),
    channelCount: num("channelCount"),
    sampleRate: num("sampleRate"),
    deviceId: str("deviceId"),
  };
}

/** How the debug panel and fixture export describe a granted value. */
export function describeConstraint(state: boolean | "not reported"): string {
  if (state === "not reported") return "not reported";
  return state ? "ON (request refused)" : "off (as requested)";
}
