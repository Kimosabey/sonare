/**
 * T8 — the ONLY React file in src/speech/.
 *
 * Everything it drives lives in src/speech/capture/, which stays framework-free
 * so it can port to React Native. Keep logic out of this file: if it isn't
 * about React state, it belongs one directory down.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Recorder } from "../capture/recorder.js";
import { CaptureError } from "../capture/errors.js";
import type { CaptureResult, GrantedConstraints, RecorderState } from "../capture/types.js";
import { scoreRecording, ScoringError } from "../scoring/client.js";
import type { PronunciationResult } from "../scoring/types.js";

export interface UseRecorderOptions {
  referenceText: string;
  language: string;
  minSnrDb?: number;
  enforceSnrGate?: boolean;
  /** Hands-free mode: the take ends on trailing silence rather than a second tap. */
  autoStop?: boolean;
  silenceHangoverMs?: number;
  /**
   * Keep the session open across utterances. Combined with autoStop the mic
   * segments on each silence and scores every utterance separately; with
   * autoStop off it records one long take until the user ends the session.
   *
   * This is still batch per utterance (R6) — each segment uploads as a complete
   * WAV. It is not continuous *recognition*.
   */
  continuous?: boolean;
  onScored?: (result: PronunciationResult, capture: CaptureResult) => void;
}

export interface RecorderErrorView {
  code: string;
  domain: string;
  userMessage: string;
  detail: string;
}

export interface UseRecorderValue {
  state: RecorderState;
  /** dBFS, updated at ~30 Hz while recording. */
  level: number;
  /** True once speech has been heard in the current take. */
  speaking: boolean;
  /** Continuous mode only: the session is open and will re-arm after each utterance. */
  sessionActive: boolean;
  /** Utterances scored in the current continuous session. */
  utteranceCount: number;
  result: PronunciationResult | null;
  error: RecorderErrorView | null;
  lastCapture: CaptureResult | null;
  granted: GrantedConstraints | null;
  contextSampleRate: number | null;
  start: () => void;
  stop: () => void;
  /** Ends a continuous session and releases the microphone. */
  endSession: () => void;
  reset: () => void;
}

export function useRecorder(options: UseRecorderOptions): UseRecorderValue {
  const [state, setState] = useState<RecorderState>("idle");
  const [level, setLevel] = useState(-90);
  const [speaking, setSpeaking] = useState(false);
  const [result, setResult] = useState<PronunciationResult | null>(null);
  const [error, setError] = useState<RecorderErrorView | null>(null);
  const [lastCapture, setLastCapture] = useState<CaptureResult | null>(null);
  const [granted, setGranted] = useState<GrantedConstraints | null>(null);
  const [contextSampleRate, setContextSampleRate] = useState<number | null>(null);
  const [sessionActive, setSessionActive] = useState(false);
  const [utteranceCount, setUtteranceCount] = useState(0);

  // Read from async continuations, so they must be refs, not state.
  const sessionActiveRef = useRef(false);

  const recorderRef = useRef<Recorder | null>(null);
  /**
   * The Recorder reads its options once, at construction. Anything the user can
   * change mid-session must appear in this key, or the control silently does
   * nothing until some unrelated change happens to rebuild the recorder.
   */
  const createdWithKey = useRef<string | null>(null);

  // Auto-stop fires from inside the capture layer, which knows nothing about
  // this hook. A ref breaks the cycle without making stop() a dependency of
  // the recorder's own construction.
  const stopRef = useRef<() => void>(() => undefined);

  // Read through a ref so changing the prompt mid-session cannot score a take
  // against the phrase the learner was not shown.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const ensureRecorder = useCallback((): Recorder => {
    const autoStop = optionsRef.current.autoStop ?? false;
    const hangover = optionsRef.current.silenceHangoverMs ?? null;
    const key = `${String(autoStop)}:${String(hangover)}`;

    // Only safe between takes — mid-recording the old instance still owns the
    // microphone. start() is the only caller and it never runs while recording.
    if (recorderRef.current && createdWithKey.current === key) {
      return recorderRef.current;
    }
    recorderRef.current?.dispose();

    const recorder = new Recorder(
      {
        minSnrDb: optionsRef.current.minSnrDb ?? 10,
        enforceSnrGate: optionsRef.current.enforceSnrGate ?? true,
        autoStop,
        ...(optionsRef.current.silenceHangoverMs === undefined
          ? {}
          : { silenceHangoverMs: optionsRef.current.silenceHangoverMs }),
      },
      {
        onState: setState,
        onLevel: setLevel,
        onError: (e) => setError(toErrorView(e)),
        onSpeechStart: () => setSpeaking(true),
        onAutoStop: () => stopRef.current(),
      },
    );

    createdWithKey.current = key;
    recorderRef.current = recorder;
    return recorder;
  }, []);

  useEffect(() => {
    return () => {
      recorderRef.current?.dispose();
      recorderRef.current = null;
    };
  }, []);

  /**
   * R10/FR-07: this must be reached synchronously from the button's click
   * handler. Do not wrap it in a timeout or an effect — iOS treats the gesture
   * as spent and the microphone will not open.
   */
  const beginTake = useCallback(() => {
    setError(null);
    setSpeaking(false);

    const recorder = ensureRecorder();
    void recorder.start().then(() => {
      setGranted(recorder.getGrantedConstraints());
      setContextSampleRate(recorder.getContextSampleRate());
    });
  }, [ensureRecorder]);

  const start = useCallback(() => {
    setResult(null);
    setLastCapture(null);
    if (optionsRef.current.continuous) {
      sessionActiveRef.current = true;
      setSessionActive(true);
      setUtteranceCount(0);
    }
    beginTake();
  }, [beginTake]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.getState() !== "recording") return;

    void (async () => {
      let capture: CaptureResult;
      try {
        capture = await recorder.stop();
      } catch {
        // The recorder already surfaced a typed error through onError.
        setSpeaking(false);
        // A rejected utterance (too short, too noisy) must not end a continuous
        // session — the learner would have to restart it after every stumble.
        if (optionsRef.current.continuous && sessionActiveRef.current) beginTake();
        return;
      }

      setSpeaking(false);
      setLastCapture(capture);
      setGranted(capture.granted);
      setContextSampleRate(capture.contextSampleRate);
      setState("processing");

      try {
        const scored = await scoreRecording({
          wav: capture.wav,
          referenceText: optionsRef.current.referenceText,
          language: optionsRef.current.language,
          contextSampleRate: capture.contextSampleRate,
          granted: capture.granted,
        });
        setResult(scored);
        optionsRef.current.onScored?.(scored, capture);
        setState("idle");
        setUtteranceCount((n) => n + 1);
      } catch (err) {
        setError(toErrorView(err));
        setState("error");
        // A failed upload ends the session rather than looping on the failure.
        sessionActiveRef.current = false;
        setSessionActive(false);
        return;
      }

      // Continuous mode: immediately listen for the next utterance. The mic is
      // still warm, so this re-arms on the same tick with no permission prompt
      // and no fresh gesture — the original tap still covers the session.
      if (optionsRef.current.continuous && sessionActiveRef.current) {
        beginTake();
      }
    })();
  }, [beginTake]);

  // Assigned in an effect rather than during render: mutating a ref while
  // rendering is unsafe under concurrent rendering, and nothing can call
  // stopRef before mount because start() requires a user gesture.
  useEffect(() => {
    stopRef.current = stop;
  }, [stop]);

  const endSession = useCallback(() => {
    sessionActiveRef.current = false;
    setSessionActive(false);
    const recorder = recorderRef.current;
    if (recorder?.getState() === "recording") {
      // Score the final utterance rather than discard it.
      stopRef.current();
    }
    recorder?.releaseMicrophone();
    setSpeaking(false);
  }, []);

  const reset = useCallback(() => {
    sessionActiveRef.current = false;
    setSessionActive(false);
    setUtteranceCount(0);
    recorderRef.current?.cancel();
    setError(null);
    setResult(null);
    setLastCapture(null);
    setLevel(-90);
    setSpeaking(false);
    setState("idle");
  }, []);

  return {
    state,
    level,
    speaking,
    sessionActive,
    utteranceCount,
    result,
    error,
    lastCapture,
    granted,
    contextSampleRate,
    start,
    stop,
    endSession,
    reset,
  };
}

function toErrorView(err: unknown): RecorderErrorView {
  if (err instanceof CaptureError || err instanceof ScoringError) {
    return {
      code: err.code,
      domain: err.domain,
      userMessage: err.userMessage,
      detail: err.message,
    };
  }
  return {
    code: "UNKNOWN",
    domain: "client",
    userMessage: "Something went wrong. Please try again.",
    detail: String(err),
  };
}
