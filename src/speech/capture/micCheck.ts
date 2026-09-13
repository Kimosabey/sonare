/**
 * The microphone check: what the browser will give us, and what the room
 * sounds like. Pure, framework-free, no DOM — the same rule the rest of this
 * directory keeps (PRD §6, enforced by path in `scripts/verify.mjs`).
 *
 * ## Why the check exists at all
 *
 * A measured 7.2% of real takes come back unusable — about one in fourteen,
 * and most of them are the *recording* rather than the scoring service. Today a
 * learner with a muted, dead or wrongly-routed microphone finds that out after
 * they have spoken, at which point it reads as the app failing to understand
 * them. The check moves the discovery in front of the first activity and ends
 * in a plain verdict.
 *
 * ## The split this file makes
 *
 * Two questions that look like one and behave nothing alike:
 *
 *  - **Availability**: whether a microphone can be used *at all*. Known before
 *    any audio, from the address, the device list and the permission. Three of
 *    its four answers need different screens, and two of them —
 *    *no hardware* and *insecure address* — are nobody's fault and must not
 *    read as though they were. There is no advice to give for either, because
 *    the learner did nothing and can undo nothing.
 *  - **Verdict**: how good the signal is, once there is one. This is a
 *    measurement, and it is reported as one.
 *
 * Keeping them apart is what stops a blocked permission being rendered as a
 * quiet room, which is the failure the old screen had: one "microphone
 * problem" state covering causes with nothing in common.
 */

/** The recorder's own gate. Below this a take is refused as SNR_TOO_LOW. */
const GATE_SNR_DB = 10;

/**
 * Where "good" starts, as a margin above the gate rather than as its own
 * number.
 *
 * A check that passed at exactly the gate would be telling a learner their
 * device is fine while sitting on the line that rejects takes — every bit of
 * room noise from then on lands the other side of it. Ten dB of headroom means
 * a verdict of *good* survives a door closing.
 */
const GOOD_SNR_DB = GATE_SNR_DB + 10;

/**
 * Long enough for the percentile estimates in `analyseSignal` to mean
 * something. Under this there are too few frames for the noise floor and the
 * speech level to be distinguishable, so the answer would be noise about
 * noise. The board says "4s is enough" and shows progress toward it.
 */
export const MIN_CHECK_SECONDS = 4;

export type PermissionState = "granted" | "denied" | "prompt" | "unknown";

/** What the environment allows, before any audio has been captured. */
export type MicAvailability =
  | { state: "available" }
  /**
   * Not a device problem and not a permission problem: a property of the
   * address. Browsers hand out a microphone only over a secure origin, so
   * there is nothing here to grant. It gets a screen of its own because the
   * fix is a different URL, which no amount of tapping in settings reaches.
   */
  | { state: "insecure" }
  /** The browser reports no input device. Nothing is blocked; there is none. */
  | { state: "no-hardware" }
  /**
   * Refused. The page cannot ask again — that is the browser's rule, not a
   * choice — so the screen is a route through settings rather than a retry.
   */
  | { state: "denied" };

export interface Environment {
  /** `window.isSecureContext`. */
  secureContext: boolean;
  /** Whether `navigator.mediaDevices.getUserMedia` exists at all. */
  hasMediaDevices: boolean;
  /**
   * Audio inputs the browser admits to, or null when it has not been asked.
   *
   * Null is not zero, and the difference decides a screen. Before permission
   * is granted, `enumerateDevices` returns entries with empty labels and can
   * legitimately report none — treating that as "no hardware" would tell a
   * learner with a perfectly good microphone that their device has none.
   */
  inputCount: number | null;
  permission: PermissionState;
}

/**
 * What the environment allows, in the order the answers become knowable.
 *
 * Order is load-bearing. An insecure page has no permission to report and no
 * device list worth reading — `mediaDevices` is usually not even defined
 * there — so asking about permission first would classify every LAN-address
 * visit as *denied* and send the learner into their settings to fix something
 * that is not broken. That exact confusion is why this is a first-class state.
 */
export function availabilityFrom(env: Environment): MicAvailability {
  if (!env.secureContext || !env.hasMediaDevices) return { state: "insecure" };
  if (env.permission === "denied") return { state: "denied" };
  // Only once permission is settled is an empty list trustworthy.
  if (env.permission === "granted" && env.inputCount === 0) return { state: "no-hardware" };
  return { state: "available" };
}

export type CheckVerdict = "good" | "quiet" | "silent";

/** What one check measured. Mirrors `SignalStats` plus the elapsed time. */
export interface CheckMeasurement {
  snrDb: number;
  /** The speech level in dBFS, for reporting rather than for deciding. */
  speechDbfs: number;
  /** The room's noise floor in dBFS, likewise. */
  roomDbfs: number;
  clippedFraction: number;
  seconds: number;
  /** `analyseSignal`'s own answer: the capture is effectively digital silence. */
  silent: boolean;
}

export interface CheckResult {
  verdict: CheckVerdict;
  /** How far the voice rose above the room, rounded for display. */
  marginDb: number;
  /** True when the take was long enough to judge. */
  conclusive: boolean;
  /**
   * Whether anything was driven past full scale.
   *
   * Reported alongside the verdict rather than folded into it, because
   * clipping and SNR disagree in the one direction that matters: a hard-
   * clipped take measures a *superb* ratio — 37.8 dB on a real one — since
   * clipping lifts the speech percentile and leaves the floor alone. A check
   * that only read SNR would call the worst possible audio excellent.
   */
  clipping: boolean;
}

/** Anything at or past this fraction of full scale is audibly distorted. */
const CLIPPING_FRACTION = 0.001;

/**
 * The verdict, from one measurement.
 *
 * `silent` is asked first and is not a low score — it is a different kind of
 * answer. A flat signal means the microphone is muted or the wrong input is
 * selected, and both are unfixable by speaking louder, which is the advice
 * every "too quiet" screen gives. Ranking it at the bottom of the same scale
 * would send those learners to try harder at a device that is not listening.
 */
export function verdictFor(measurement: CheckMeasurement): CheckResult {
  const marginDb = Math.round(measurement.snrDb);
  const clipping = measurement.clippedFraction >= CLIPPING_FRACTION;
  const conclusive = measurement.seconds >= MIN_CHECK_SECONDS;

  if (measurement.silent || measurement.snrDb <= 0) {
    return { verdict: "silent", marginDb: 0, conclusive, clipping };
  }

  /**
   * Clipping fails the check however good the ratio looks. It is the one case
   * where a learner *is* being heard and the recording is still unusable, and
   * the fix — move back, turn the input down — is the opposite of what a
   * *quiet* verdict advises. Calling it quiet would be actively misleading.
   */
  if (clipping || measurement.snrDb < GOOD_SNR_DB) {
    return { verdict: "quiet", marginDb, conclusive, clipping };
  }

  return { verdict: "good", marginDb, conclusive, clipping };
}
