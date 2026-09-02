/**
 * Turns recorder lifecycle transitions into toasts.
 *
 * Lives outside src/speech/ on purpose: TASKS.md T8 makes useRecorder.ts the
 * only React file under src/speech/, and this is presentation, not capture.
 *
 * Every status shares one toast key so a take produces a single toast that
 * updates in place — "Listening" → "Scoring" → "Scored 87" — rather than three
 * stacked notifications for one action.
 */

import { useEffect, useRef } from "react";
import { useToast } from "./ToastProvider.js";
import type { UseRecorderValue } from "../speech/react/useRecorder.js";

/**
 * SNR at or above this means the capture layer genuinely heard speech, so an
 * indeterminate result is the scorer failing to match it rather than an audio
 * problem. Well below the takes that scored 93-99 in testing (12.8-33 dB), so
 * it does not mistake a quiet room for a failed match.
 */
export const HEARD_SPEECH_SNR_DB = 10;

const CAPTURE_KEY = "capture";

export interface CaptureToastOptions {
  autoStop: boolean;
  /** Suppress the per-score toast where the page already renders the result prominently. */
  announceScore?: boolean;
  /** Attached to any diagnostic this hook reports — see ActivityTest.tsx. */
  sessionId?: string;
  activityId?: number;
  learnerName?: string;
}

export function useCaptureToasts(recorder: UseRecorderValue, options: CaptureToastOptions): void {
  const toast = useToast();
  const prevState = useRef(recorder.state);
  const prevSpeaking = useRef(false);
  const lastResult = useRef(recorder.result);
  const lastErrorCode = useRef<string | null>(null);
  const announceScore = options.announceScore ?? true;

  // ── lifecycle ────────────────────────────────────────────────────────────
  useEffect(() => {
    const from = prevState.current;
    const to = recorder.state;
    prevState.current = to;
    if (from === to) return;

    if (to === "requesting") {
      toast.push({ key: CAPTURE_KEY, kind: "info", title: "Opening microphone…" });
      return;
    }

    if (to === "recording") {
      toast.push({
        key: CAPTURE_KEY,
        kind: "info",
        title: options.autoStop ? "Listening…" : "Recording",
        detail: options.autoStop
          ? "Speak now — it stops on its own when you finish."
          : "Tap stop when you have finished.",
        // Pinned: it describes an ongoing state, so it should not vanish
        // while the learner is still talking.
        duration: 0,
      });
      return;
    }

    if (to === "processing") {
      toast.push({ key: CAPTURE_KEY, kind: "info", title: "Scoring…", duration: 0 });
      // Scoring a short clip is normally sub-second; past a few seconds the
      // silence reads as "stuck" rather than "slow connection" — say so.
      const stillScoringTimer = setTimeout(() => {
        toast.push({
          key: CAPTURE_KEY,
          kind: "info",
          title: "Still scoring…",
          detail: "Taking longer than usual — hang tight on a slow connection.",
          duration: 0,
        });
      }, 4000);
      return () => clearTimeout(stillScoringTimer);
    }
  }, [recorder.state, options.autoStop, toast]);

  // ── speech detected ──────────────────────────────────────────────────────
  useEffect(() => {
    if (recorder.speaking && !prevSpeaking.current && options.autoStop) {
      toast.push({
        key: CAPTURE_KEY,
        kind: "info",
        title: "Got you — keep going",
        detail: "Recording stops automatically after you stop speaking.",
        duration: 0,
      });
    }
    prevSpeaking.current = recorder.speaking;
  }, [recorder.speaking, options.autoStop, toast]);

  // ── result ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const result = recorder.result;
    if (!result || result === lastResult.current) return;
    lastResult.current = result;
    if (!announceScore) return;

    if (result.indeterminate) {
      // R8: never a number here. But "unclear" and "unmatched" are different
      // facts and deserve different advice — telling a learner who spoke
      // clearly to be louder sends them off to debug a microphone that is
      // perfectly fine. See the recorded evidence in ScoreCard.tsx.
      const heard = (recorder.lastCapture?.snrDb ?? 0) >= HEARD_SPEECH_SNR_DB;
      toast.push({
        key: CAPTURE_KEY,
        kind: "warn",
        title: heard ? "Couldn't match that to the phrase" : "Couldn't get a clear read",
        detail: heard
          ? "We heard you clearly. Try it slower, one word at a time."
          : "Try again a little louder, or somewhere quieter.",
      });
      return;
    }

    const score = Math.round(result.accuracy);
    toast.push({
      key: CAPTURE_KEY,
      kind: score >= 80 ? "success" : score >= 60 ? "info" : "warn",
      title: `Scored ${score}`,
      detail:
        score >= 80
          ? "Clear pronunciation."
          : score >= 60
            ? "Understandable — check the highlighted words."
            : "Tap a word below to see which sounds went wrong.",
    });
  }, [recorder.result, announceScore, toast]);

  // ── errors ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const error = recorder.error;
    if (!error) {
      lastErrorCode.current = null;
      return;
    }
    if (error.code === lastErrorCode.current) return;
    lastErrorCode.current = error.code;

    toast.push({
      key: CAPTURE_KEY,
      kind: "error",
      title: error.userMessage,
      detail: `${error.code} · ${error.domain}`,
    });

    // Fire-and-forget — a failed diagnostic POST must never surface as its
    // own error. userAgent identifies browser/OS/version; granted +
    // contextSampleRate are the device-capture signals only the client has.
    void fetch("/api/v1/diagnostics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: error.code,
        domain: error.domain,
        message: error.detail,
        userMessage: error.userMessage,
        sessionId: options.sessionId,
        activityId: options.activityId,
        learnerName: options.learnerName,
        context: {
          userAgent: navigator.userAgent,
          granted: recorder.granted,
          contextSampleRate: recorder.contextSampleRate,
        },
      }),
    }).catch(() => undefined);
  }, [
    recorder.error,
    recorder.granted,
    recorder.contextSampleRate,
    options.sessionId,
    options.activityId,
    options.learnerName,
    toast,
  ]);
}
