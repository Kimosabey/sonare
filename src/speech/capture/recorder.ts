/**
 * T5/T7 — the capture state machine. Framework-free by design (NFR-05): this
 * file ports to React Native, so nothing here may know React exists.
 *
 * R11: all state is in-memory. Nothing here touches browser-persistent storage —
 * a stale audio config surviving a reload produces bugs that cannot be
 * reproduced, which during a fixture run would be indistinguishable from a real
 * platform finding.
 */

import { acquireMicrophone, readGrantedConstraints } from "./constraints.js";
import { captureError, CaptureError } from "./errors.js";
import { concatFrames, resampleTo16k, TARGET_SAMPLE_RATE } from "./resample.js";
import { analyseSignal, frameLevelDbfs } from "./snr.js";
import { encodeWav } from "./wav.js";
import { addCaptureWorklet, WORKLET_PROCESSOR_NAME } from "./worklet.js";
import type { CaptureResult, GrantedConstraints, RecorderState } from "./types.js";

export interface RecorderOptions {
  minSeconds?: number;
  maxSeconds?: number;
  minSnrDb?: number;
  /** Reject when this fraction of samples or more sits at full scale. */
  maxClippedFraction?: number;
  /** The fixture runner may want the raw take regardless of noise. */
  enforceSnrGate?: boolean;
  /** Stop on trailing silence instead of waiting for a second tap. */
  autoStop?: boolean;
  /** Silence after speech that ends the take. */
  silenceHangoverMs?: number;
  /** Frame level above which we treat audio as speech rather than room noise. */
  speechThresholdDb?: number;
  /**
   * Hold the microphone open between takes so the next Start records
   * instantly. Re-running getUserMedia costs a few hundred milliseconds and
   * re-introduces the warm-up frames that corrupt the noise-floor estimate.
   */
  keepMicWarm?: boolean;
  /** Release a warm microphone after this long idle. 0 disables the release. */
  idleReleaseMs?: number;
}

export interface RecorderListeners {
  onState?: (state: RecorderState) => void;
  onLevel?: (dbfs: number) => void;
  onError?: (error: CaptureError) => void;
  /** Trailing silence ended the take; the owner should now call stop(). */
  onAutoStop?: () => void;
  /** True once speech has been heard, so the UI can stop saying "waiting". */
  onSpeechStart?: () => void;
}

const DEFAULTS = {
  // README finding: 8/80 synthetic single-word attempts were false-rejected
  // as AUDIO_TOO_SHORT at 0.4s — short words genuinely don't reach that.
  // 0.25s is the README's own suggested floor.
  minSeconds: 0.25,
  maxSeconds: 15,
  minSnrDb: 10,
  /**
   * 2% of samples at full scale. Generous on purpose: a plosive or a knock
   * can legitimately touch the ceiling, and rejecting a usable take is worse
   * than scoring a slightly hot one. Sustained clipping runs far above this —
   * the real take that triggered this gate sat at +6.3 dBFS peak.
   */
  maxClippedFraction: 0.02,
  enforceSnrGate: true,
  autoStop: true,
  /**
   * Trailing silence that ends a take.
   *
   * Learners pause mid-sentence far more than fluent speakers do — for breath,
   * at commas, and while retrieving the next word. Anything near a second cuts
   * people off in the middle of a phrase, which reads as the app being broken.
   * Waiting an extra second at the end is a much cheaper mistake than
   * truncating the utterance, because a truncated take is scored as an
   * omission and the learner is blamed for our timing.
   *
   * Use hangoverForReference() to scale this to the length of the prompt.
   */
  silenceHangoverMs: 2200,
  /**
   * Fallback only. The endpointer normally calibrates to the room — see
   * calibrateThreshold(). A fixed number cannot work across a quiet laptop
   * (~-65 dBFS room tone) and a classroom (~-40), and setting it too high
   * clips quiet trailing consonants, which is what makes an endpointer feel
   * like it is cutting people off.
   */
  speechThresholdDb: -50,
  keepMicWarm: true,
  /**
   * The OS microphone indicator stays lit while the mic is warm, so we do not
   * hold it indefinitely. Long enough to cover reading the next prompt,
   * short enough that a learner who walks away is not left recording-capable.
   */
  idleReleaseMs: 45_000,
} as const;

/**
 * Speech must last at least this long before the endpointer will arm. Stops a
 * cough, a chair scrape or a door closing from counting as "they started
 * talking" and then immediately ending the take.
 */
const MIN_SPEECH_MS = 300;

/**
 * A frame above threshold only pushes the hangover countdown back out once
 * it's been part of a run at least this long — real speech to reproduce.
 * Without this, a single ~3ms worklet frame crossing the (necessarily
 * noise-tolerant) threshold — a click, a chair creak, AC cycling, a breath
 * right at the end of a phrase — resets the countdown just as effectively as
 * genuine continued speech, so a noisy-but-quiet room can push auto-stop out
 * indefinitely. Short enough that it never delays recognizing real renewed
 * speech (well under a syllable), long enough to reject a single-frame blip.
 */
const MIN_RENEWED_SPEECH_MS = 80;

/**
 * Longer prompts earn more patience: more words means more internal pauses,
 * and the cost of waiting is far lower than the cost of truncating.
 */
export function hangoverForReference(referenceText: string): number {
  const words = referenceText.trim().split(/\s+/).filter(Boolean).length;
  if (words <= 2) return 1200;
  if (words <= 5) return 1600;
  if (words <= 9) return 2000;
  return 2400;
}

/**
 * Frames quieter than this are microphone warm-up or digital silence, not the
 * room. Including them collapses the measured floor toward -90 dBFS, which puts
 * the speech threshold *below* real room tone — every frame then reads as
 * speech and the take never ends. That is the failure this constant prevents.
 */
const FLOOR_IGNORE_BELOW_DB = -75;

/**
 * The mirror-image guard for the peak side: frames within this long of
 * capture starting never enter the peak estimate. A worklet/AudioContext
 * startup transient landing here would otherwise permanently raise the
 * threshold for the rest of the take — see calibrateThreshold().
 */
const PEAK_CALIBRATION_GRACE_MS = 150;

/** Speech must exceed the measured floor by this much to count. */
const SPEECH_MARGIN_DB = 12;

/**
 * Speech is also required to be within this range of the loudest frame heard.
 * Anchoring to the speaker's own level is what makes the endpointer work in a
 * noisy room: absolute thresholds cannot tell a loud room from a quiet talker.
 */
const SPEECH_PEAK_DROP_DB = 28;

/** The threshold is clamped into this band whatever the room does. */
const THRESHOLD_FLOOR_DB = -58;
const THRESHOLD_CEILING_DB = -30;

/** FR-06: the meter needs ≥ 20 Hz. 30 Hz looks smooth without flooding React. */
const LEVEL_INTERVAL_MS = 1000 / 30;

/** FR-09: silence for this long means something is wrong, not that they paused. */
const SILENCE_WATCHDOG_MS = 3000;

/** Below this RMS a frame counts as no signal at all. */
const ENERGY_THRESHOLD = 1e-4;

export class Recorder {
  private state: RecorderState = "idle";
  private readonly options: Required<RecorderOptions>;
  private readonly listeners: RecorderListeners;

  private stream: MediaStream | null = null;
  private track: MediaStreamTrack | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;

  private frames: Float32Array[] = [];
  private capturing = false;
  private granted: GrantedConstraints | null = null;

  private lastLevelAt = 0;
  private sawEnergy = false;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;

  private sampleCount = 0;
  private heardSpeech = false;
  private lastSpeechAt = 0;
  private autoStopFired = false;
  /** Consecutive time above threshold since the last frame that wasn't — see MIN_RENEWED_SPEECH_MS. */
  private aboveThresholdRunMs = 0;

  private captureStartedAt = 0;
  private noiseFloorDb: number | null = null;
  private peakSpeechDb: number | null = null;
  private speechMs = 0;
  private lastFrameAt = 0;

  /** True when stream + context + worklet are live and reusable. */
  private graphReady = false;
  private idleReleaseTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Bumped by every cancel/release. start() captures it before each await and
   * bails if it has moved.
   *
   * Without this, cancelling while getUserMedia is still resolving does
   * nothing — stream, track and context are all still null, so teardown has
   * nothing to tear down. The permission then resolves into an orphaned
   * recorder that opens the microphone and captures forever, with no reference
   * left to stop it. Navigating away mid-prompt is enough to trigger it.
   */
  private generation = 0;
  /** Exposed for the debug panel — this is the number to look at when endpointing misbehaves. */
  private currentThresholdDb = 0;

  constructor(options: RecorderOptions = {}, listeners: RecorderListeners = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.listeners = listeners;
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  getState(): RecorderState {
    return this.state;
  }

  getGrantedConstraints(): GrantedConstraints | null {
    return this.granted;
  }

  getContextSampleRate(): number | null {
    return this.context?.sampleRate ?? null;
  }

  /**
   * R10/FR-07 — must be called from a user gesture. iOS requires it; there is
   * no workaround and we are not going to invent one.
   */
  async start(): Promise<void> {
    if (this.state === "recording") return;

    // Chrome and Edge expose this; Safari does not. When it is absent we cannot
    // tell, so we proceed and let getUserMedia be the authority.
    const activation = navigator.userActivation;
    if (activation && activation.isActive === false) {
      this.fail(captureError("GESTURE_REQUIRED", "start() called outside a user gesture"));
      return;
    }

    this.setAudioSessionType();
    this.cancelIdleRelease();

    // Warm path: the graph from the previous take is still live, so recording
    // begins on this tick with no getUserMedia round trip and no warm-up frames.
    if (this.canReuseGraph()) {
      this.setState("ready");
      this.beginCapture();
      return;
    }

    this.setState("requesting");

    const startedAt = this.generation;
    const stale = (): boolean => this.generation !== startedAt;

    try {
      const mic = await acquireMicrophone();

      // Cancelled while the permission prompt was open. The stream exists now
      // but nobody wants it — hand it straight back rather than let it live on
      // in a recorder that has already been disposed.
      if (stale()) {
        mic.stream.getTracks().forEach((t) => t.stop());
        return;
      }

      this.stream = mic.stream;
      this.track = mic.track;
      this.granted = mic.granted;

      await this.buildGraph();

      // buildGraph awaits addModule(), so check again before going live.
      if (stale()) {
        this.releaseAudio();
        return;
      }

      this.graphReady = true;
      this.setState("ready");
      this.beginCapture();
    } catch (err) {
      // Read staleness BEFORE releasing — releaseAudio() bumps the generation,
      // which would make every failure look cancelled and swallow the error.
      const cancelled = stale();
      this.releaseAudio();
      if (cancelled) return;
      this.fail(err instanceof CaptureError ? err : captureError("UNSUPPORTED_BROWSER", String(err)));
    }
  }

  private canReuseGraph(): boolean {
    return (
      this.graphReady &&
      this.track?.readyState === "live" &&
      this.context?.state === "running" &&
      this.node !== null
    );
  }

  /** Resolves with the encoded take, or rejects with a typed CaptureError. */
  async stop(): Promise<CaptureResult> {
    if (this.state !== "recording") {
      throw captureError("TOO_SHORT", `stop() called while ${this.state}`);
    }

    this.capturing = false;
    this.clearTimers();
    this.setState("processing");

    const contextSampleRate = this.context?.sampleRate ?? TARGET_SAMPLE_RATE;
    const granted = this.granted;
    const endpoint = { ...this.getEndpointDiagnostics(), autoStopped: this.autoStopFired };
    const raw = concatFrames(this.frames);
    this.frames = [];

    // Keep the microphone open for the next take, but stop accumulating.
    // Frames still arrive; onFrame() drops them because capturing is false.
    if (this.options.keepMicWarm && this.canReuseGraph()) {
      this.scheduleIdleRelease();
    } else {
      this.releaseAudio();
    }

    try {
      const durationSeconds = raw.length / contextSampleRate;

      // FR-11. Checked before the SNR work so a stray tap fails fast and cheap.
      if (durationSeconds < this.options.minSeconds) {
        throw captureError("TOO_SHORT", `${durationSeconds.toFixed(2)}s below ${this.options.minSeconds}s`);
      }
      if (durationSeconds > this.options.maxSeconds) {
        throw captureError("TOO_LONG", `${durationSeconds.toFixed(2)}s above ${this.options.maxSeconds}s`);
      }

      const stats = analyseSignal(raw, contextSampleRate);

      if (stats.silent) {
        throw captureError("NO_AUDIO_ENERGY", `peak ${stats.peakDbfs.toFixed(1)} dBFS`);
      }

      /**
       * Checked before the SNR gate, because SNR cannot see this. Clipping
       * *raises* the speech percentile while leaving the noise floor alone, so
       * a destroyed take scores a great SNR and sails through — then Azure
       * returns NoMatch and the learner is told "no speech recognised" after
       * speaking clearly. Same enforceSnrGate flag: the fixture runner wants
       * the raw take either way.
       */
      if (this.options.enforceSnrGate && stats.clippedFraction >= this.options.maxClippedFraction) {
        throw captureError(
          "LEVEL_TOO_HOT",
          `${(stats.clippedFraction * 100).toFixed(1)}% of samples clipped ` +
            `(peak ${stats.peakDbfs.toFixed(1)} dBFS), at or above the ` +
            `${(this.options.maxClippedFraction * 100).toFixed(1)}% ceiling`,
        );
      }

      // T10: refuse to send audio that will produce a meaningless score.
      if (this.options.enforceSnrGate && stats.snrDb < this.options.minSnrDb) {
        throw captureError("SNR_TOO_LOW", `SNR ${stats.snrDb.toFixed(1)} dB below ${this.options.minSnrDb} dB`);
      }

      // resampleTo16k() passes audio through unresampled below the target
      // rate, on the assumption every browser AudioContext runs at 44.1kHz+.
      // A Bluetooth HFP (narrowband) route can pin the whole audio session —
      // including this context — below that. Encoding the header as 16kHz
      // anyway would hand the scorer real audio at a fabricated rate: pitch
      // and duration both come out wrong, silently, instead of failing loud.
      if (contextSampleRate < TARGET_SAMPLE_RATE) {
        throw captureError(
          "UNSUPPORTED_SAMPLE_RATE",
          `context sample rate ${contextSampleRate}Hz is below the ${TARGET_SAMPLE_RATE}Hz target`,
        );
      }

      const resampled = resampleTo16k(raw, contextSampleRate);
      const wav = encodeWav(resampled, TARGET_SAMPLE_RATE);

      this.setState("idle");

      return {
        wav,
        durationSeconds,
        contextSampleRate,
        granted: granted ?? emptyConstraints(),
        snrDb: stats.snrDb,
        peakDbfs: stats.peakDbfs,
        endpoint,
      };
    } catch (err) {
      const typed = err instanceof CaptureError ? err : captureError("UNSUPPORTED_BROWSER", String(err));
      this.fail(typed);
      throw typed;
    }
  }

  /**
   * Abandons an in-flight take. Keeps the microphone warm so the learner can
   * immediately retry — use releaseMicrophone() to actually let it go.
   */
  cancel(): void {
    this.generation++;
    this.capturing = false;
    this.clearTimers();
    this.frames = [];
    if (this.options.keepMicWarm && this.canReuseGraph()) {
      this.scheduleIdleRelease();
    } else {
      this.releaseAudio();
    }
    this.setState("idle");
  }

  /** Hands the microphone back to the OS immediately. */
  releaseMicrophone(): void {
    this.generation++;
    this.capturing = false;
    this.frames = [];
    this.releaseAudio();
  }

  dispose(): void {
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.releaseMicrophone();
    this.setState("idle");
  }

  private scheduleIdleRelease(): void {
    this.cancelIdleRelease();
    if (this.options.idleReleaseMs <= 0) return;
    this.idleReleaseTimer = setTimeout(() => {
      // Only if still idle — a take started in the meantime keeps it alive.
      if (!this.capturing) this.releaseAudio();
    }, this.options.idleReleaseMs);
  }

  private cancelIdleRelease(): void {
    if (this.idleReleaseTimer) {
      clearTimeout(this.idleReleaseTimer);
      this.idleReleaseTimer = null;
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async buildGraph(): Promise<void> {
    const AudioContextCtor =
      window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

    if (!AudioContextCtor) {
      throw captureError("UNSUPPORTED_BROWSER", "AudioContext is unavailable");
    }

    const context = new AudioContextCtor();
    this.context = context;

    // FR-08: iOS hands back a suspended context when another app holds the
    // audio session. Resuming inside the gesture is the only reliable moment.
    if (context.state === "suspended") {
      await context.resume();
    }
    if (context.state !== "running") {
      throw captureError("CONTEXT_SUSPENDED", `AudioContext is ${context.state}`);
    }

    await addCaptureWorklet(context);

    if (!this.stream) throw captureError("DEVICE_LOST", "stream disappeared before graph construction");

    this.source = context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(context, WORKLET_PROCESSOR_NAME);
    this.node.port.onmessage = (event: MessageEvent<Float32Array>) => this.onFrame(event.data);

    this.source.connect(this.node);
    // Keeps the graph pulling. A worklet that returns no output is silent, so
    // this produces no audible feedback loop.
    this.node.connect(context.destination);

    this.watchForDeviceLoss(context);
  }

  private watchForDeviceLoss(context: AudioContext): void {
    // FR-08: fail with a typed error rather than hanging.
    if (this.track) {
      this.track.onended = () => {
        if (this.capturing) this.fail(captureError("DEVICE_LOST", "audio track ended"));
      };
    }

    context.onstatechange = () => {
      if (this.capturing && context.state !== "running") {
        this.fail(captureError("CONTEXT_SUSPENDED", `AudioContext became ${context.state}`));
      }
    };

    if (navigator.mediaDevices) {
      navigator.mediaDevices.addEventListener("devicechange", this.onDeviceChange);
    }
  }

  private onDeviceChange = (): void => {
    if (!this.capturing || !this.track) return;

    if (this.track.readyState === "ended") {
      this.fail(captureError("DEVICE_LOST", "capture device went away"));
      return;
    }

    // The track can also survive a route change (e.g. AirPods connecting or
    // disconnecting mid-take) without ever ending — the OS just re-points the
    // same MediaStreamTrack at a different physical input, with its own DSP
    // and noise floor the page never asked about. `granted` (read once at
    // acquisition) and the debug panel would then silently describe a take
    // that was actually split across two capture paths. Re-reading settings
    // here and failing on a real change is cheaper than shipping a
    // corrupted/mis-scored WAV under stale metadata.
    if (!this.granted) return;
    const current = readGrantedConstraints(this.track);
    const deviceChanged =
      current.deviceId !== "not reported" &&
      this.granted.deviceId !== "not reported" &&
      current.deviceId !== this.granted.deviceId;
    const rateChanged =
      current.sampleRate !== "not reported" &&
      this.granted.sampleRate !== "not reported" &&
      current.sampleRate !== this.granted.sampleRate;

    if (deviceChanged || rateChanged) {
      this.fail(
        captureError(
          "ROUTE_CHANGED",
          `input changed mid-take (device ${String(this.granted.deviceId)} -> ${String(current.deviceId)}, rate ${String(this.granted.sampleRate)} -> ${String(current.sampleRate)})`,
        ),
      );
    }
  };

  /**
   * iOS suspends this tab's JS while backgrounded, so the events buildGraph()
   * already listens for (track.onended, context.onstatechange) may simply
   * never run during an interruption — a call, another app grabbing the
   * audio session, or the screen locking mid-take. Left alone, the take can
   * hang in "recording" forever with no error and no result. Re-validating on
   * return to the foreground catches what those events missed instead of
   * trusting a take that ran unobserved.
   */
  private onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") {
      // The idle-release timer is a plain setTimeout, which iOS throttles
      // once the tab backgrounds — it can't be trusted to fire promptly.
      // Release a warm-but-idle mic immediately instead; an active recording
      // is untouched (capturing stays true; this only fires when it's false).
      if (!this.capturing) this.releaseAudio();
      return;
    }

    if (this.capturing && (this.track?.readyState !== "live" || this.context?.state !== "running")) {
      this.fail(
        captureError(
          "INTERRUPTED",
          `visibility resumed mid-take with track=${this.track?.readyState ?? "none"} context=${this.context?.state ?? "none"}`,
        ),
      );
    }
  };

  /**
   * Feature-detected, and does nothing for the DSP question R4/R5 exist for —
   * the Audio Session API controls session *type* and interruption behaviour,
   * not gain control/noise suppression/echo cancellation. What it does fix: a
   * documented iOS Safari bug where granting getUserMedia can silently
   * reroute audio output to the built-in speaker even with a Bluetooth or
   * wired headset connected. Must run before acquireMicrophone() — the bug is
   * triggered by the grant itself, not by anything that happens afterward.
   */
  private setAudioSessionType(): void {
    if (!("audioSession" in navigator)) return;
    try {
      (navigator as Navigator & { audioSession: { type: string } }).audioSession.type = "play-and-record";
    } catch {
      // Non-fatal — worst case is the routing bug this was meant to avoid.
    }
  }

  private beginCapture(): void {
    this.frames = [];
    this.sawEnergy = false;
    this.sampleCount = 0;
    this.heardSpeech = false;
    this.lastSpeechAt = 0;
    this.autoStopFired = false;
    this.aboveThresholdRunMs = 0;
    this.captureStartedAt = performance.now();
    this.noiseFloorDb = null;
    this.peakSpeechDb = null;
    this.currentThresholdDb = 0;
    this.speechMs = 0;
    this.lastFrameAt = 0;
    this.capturing = true;
    this.setState("recording");

    // FR-09
    this.silenceTimer = setTimeout(() => {
      if (this.capturing && !this.sawEnergy) {
        this.fail(captureError("NO_AUDIO_ENERGY", `no signal within ${SILENCE_WATCHDOG_MS} ms`));
      }
    }, SILENCE_WATCHDOG_MS);

    // FR-11: stop at the ceiling rather than let a take run away and then
    // reject it — losing a recording after the fact is worse than ending it.
    //
    // This notifies the owner instead of calling stop() itself. Stopping here
    // would resolve a CaptureResult inside the recorder that nobody is awaiting,
    // so the take would be encoded and then silently dropped — the learner sees
    // recording end and no score ever arrives.
    this.maxDurationTimer = setTimeout(
      () => {
        if (!this.capturing || this.autoStopFired) return;
        this.autoStopFired = true;
        if (this.listeners.onAutoStop) {
          this.listeners.onAutoStop();
        } else {
          // No owner listening: end the take so the mic is released.
          void this.stop().catch(() => undefined);
        }
      },
      this.options.maxSeconds * 1000,
    );
  }

  private onFrame(frame: Float32Array): void {
    if (!this.capturing) return;

    this.frames.push(frame);
    this.sampleCount += frame.length;

    const level = frameLevelDbfs(frame);
    if (level > -80) this.sawEnergy = true;

    for (let i = 0; i < frame.length; i++) {
      if (Math.abs(frame[i] ?? 0) > ENERGY_THRESHOLD) {
        this.sawEnergy = true;
        break;
      }
    }

    const now = performance.now();

    if (now - this.lastLevelAt >= LEVEL_INTERVAL_MS) {
      this.lastLevelAt = now;
      this.listeners.onLevel?.(level);
    }

    if (this.options.autoStop) this.trackEndpoint(level, now);
  }

  /**
   * Endpointing: end the take once the learner stops talking.
   *
   * The hangover only starts after speech has actually been heard, so a learner
   * who takes a moment to begin is not cut off before they start — that case is
   * the FR-09 watchdog's job, not this one. We also refuse to stop below the
   * minimum duration, because auto-stopping into a TOO_SHORT rejection would
   * blame the learner for our own timing.
   */
  private trackEndpoint(level: number, now: number): void {
    if (this.autoStopFired) return;

    const threshold = this.calibrateThreshold(level, now - this.captureStartedAt);

    const sinceLastFrame = this.lastFrameAt === 0 ? 0 : now - this.lastFrameAt;
    this.lastFrameAt = now;

    if (level > threshold) {
      // Cap the increment so a stalled main thread cannot arm the endpointer
      // in a single frame.
      const capped = Math.min(sinceLastFrame, 100);
      this.speechMs += capped;
      this.aboveThresholdRunMs += capped;
      if (!this.heardSpeech && this.speechMs >= MIN_SPEECH_MS) {
        this.heardSpeech = true;
        this.listeners.onSpeechStart?.();
      }
      // Only a run that's lasted long enough to plausibly be speech pushes
      // the hangover countdown back out — a lone noise-transient frame
      // crossing the (necessarily noise-tolerant) threshold must not.
      if (this.aboveThresholdRunMs >= MIN_RENEWED_SPEECH_MS) {
        this.lastSpeechAt = now;
      }
      return;
    }

    // The run is broken — the next frame above threshold starts a fresh one.
    this.aboveThresholdRunMs = 0;

    if (!this.heardSpeech || this.lastSpeechAt === 0) return;
    if (this.speechMs < MIN_SPEECH_MS) return;
    if (now - this.lastSpeechAt < this.options.silenceHangoverMs) return;

    const contextRate = this.context?.sampleRate ?? TARGET_SAMPLE_RATE;
    if (this.sampleCount / contextRate < this.options.minSeconds) return;

    this.autoStopFired = true;
    this.listeners.onAutoStop?.();
  }

  /**
   * Adapt to the room AND to the speaker, continuously.
   *
   * Two references, because either alone fails:
   *
   *  - floor + margin handles a quiet room with a quiet talker.
   *  - peak - drop handles a NOISY room, where an absolute threshold cannot
   *    separate a loud room from a soft voice. Anchoring to the loudest frame
   *    we have actually heard makes the threshold track the speaker.
   *
   * The higher of the two wins, then it is clamped. Frames below
   * FLOOR_IGNORE_BELOW_DB never enter the floor estimate — mic warm-up would
   * otherwise drag it to near-digital-silence and the endpointer would never
   * release.
   *
   * The peak side needs the mirror-image guard: a worklet/AudioContext
   * startup transient (a click or brief handling pop) can be louder than the
   * speech that follows, and because peakSpeechDb only ever increases, one
   * such frame permanently raises the threshold for the rest of the take —
   * real speech then never registers as speech, and the take runs to
   * MAX_SECONDS instead of auto-stopping. Real-world evidence: every observed
   * TOO_LONG failure landed within a few hundred ms of MAX_SECONDS exactly,
   * on the first take of a session (right after mic warm-up), across
   * multiple browsers/OSes — consistent with a startup artifact, not a
   * device- or room-specific audio quality issue.
   */
  private calibrateThreshold(level: number, elapsedMs: number): number {
    if (level > FLOOR_IGNORE_BELOW_DB) {
      this.noiseFloorDb = this.noiseFloorDb === null ? level : Math.min(this.noiseFloorDb, level);
    }
    if (elapsedMs >= PEAK_CALIBRATION_GRACE_MS && (this.peakSpeechDb === null || level > this.peakSpeechDb)) {
      this.peakSpeechDb = level;
    }

    const floor = this.noiseFloorDb ?? this.options.speechThresholdDb;
    const fromFloor = floor + SPEECH_MARGIN_DB;
    const fromPeak = this.peakSpeechDb === null ? fromFloor : this.peakSpeechDb - SPEECH_PEAK_DROP_DB;

    this.currentThresholdDb = Math.min(
      THRESHOLD_CEILING_DB,
      Math.max(THRESHOLD_FLOOR_DB, Math.max(fromFloor, fromPeak)),
    );
    return this.currentThresholdDb;
  }

  /** Endpointer diagnostics, for the debug panel. */
  getEndpointDiagnostics(): { thresholdDb: number; noiseFloorDb: number | null; peakDb: number | null } {
    return {
      thresholdDb: this.currentThresholdDb,
      noiseFloorDb: this.noiseFloorDb,
      peakDb: this.peakSpeechDb,
    };
  }

  private clearTimers(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer);
    this.silenceTimer = null;
    this.maxDurationTimer = null;
  }

  private releaseAudio(): void {
    this.clearTimers();
    this.generation++;
    this.cancelIdleRelease();
    this.graphReady = false;

    if (navigator.mediaDevices) {
      navigator.mediaDevices.removeEventListener("devicechange", this.onDeviceChange);
    }

    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
      this.node = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.context) {
      this.context.onstatechange = null;
      void this.context.close().catch(() => undefined);
      this.context = null;
    }
    if (this.track) {
      this.track.onended = null;
      this.track = null;
    }
    if (this.stream) {
      // Releases the mic so the OS indicator goes out between takes.
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }

  private setState(state: RecorderState): void {
    this.state = state;
    this.listeners.onState?.(state);
  }

  private fail(error: CaptureError): void {
    this.capturing = false;
    this.clearTimers();
    this.releaseAudio();
    this.setState("error");
    this.listeners.onError?.(error);
  }
}

function emptyConstraints(): GrantedConstraints {
  return {
    echoCancellation: "not reported",
    autoGainControl: "not reported",
    noiseSuppression: "not reported",
    channelCount: "not reported",
    sampleRate: "not reported",
    deviceId: "not reported",
  };
}
