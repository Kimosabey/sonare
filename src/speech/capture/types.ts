/**
 * Capture layer types. Framework-free — this directory ports to React Native.
 */

/**
 * What the browser actually granted. R5/FR-04: a key absent from getSettings()
 * is reported as "not reported", never assumed false. On Safari "not reported"
 * is the expected and correct outcome, and conflating it with "granted false"
 * would fabricate exactly the evidence the fixture depends on.
 */
export type ConstraintState = boolean | "not reported";

export interface GrantedConstraints {
  echoCancellation: ConstraintState;
  autoGainControl: ConstraintState;
  noiseSuppression: ConstraintState;
  channelCount: number | "not reported";
  sampleRate: number | "not reported";
  deviceId: string | "not reported";
}

/** FR-05 lifecycle. */
export type RecorderState = "idle" | "requesting" | "ready" | "recording" | "processing" | "error";

export interface CaptureResult {
  /** 16 kHz mono 16-bit PCM WAV — R7. */
  wav: Blob;
  durationSeconds: number;
  /** The AudioContext rate we captured at, before resampling. */
  contextSampleRate: number;
  granted: GrantedConstraints;
  /** Estimated signal-to-noise ratio in dB, used by the T10 gate. */
  snrDb: number;
  peakDbfs: number;
  /**
   * What the endpointer decided, for diagnosing auto-stop behaviour on a real
   * device. thresholdDb below the room's noise floor means it will never stop.
   */
  endpoint: {
    thresholdDb: number;
    noiseFloorDb: number | null;
    peakDb: number | null;
    /** True when trailing silence ended the take rather than a tap. */
    autoStopped: boolean;
  };
}

export interface DeviceContext {
  ua: string;
  contextRate: number | null;
  granted: GrantedConstraints | null;
}
