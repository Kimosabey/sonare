/**
 * T9/FR-12 — upload a complete take for scoring.
 *
 * R6: one batch POST per utterance. No WebSocket, no streaming — the scorer
 * cannot begin until the learner has finished the phrase, so streaming would
 * add session state and reconnection handling while reducing nothing.
 */

import type { DeviceContext, GrantedConstraints } from "../capture/types.js";
import type { ApiErrorBody, PronunciationResult } from "./types.js";

const ENDPOINT = "/api/v1/pronunciation";

/**
 * Retries for a dropped connection only, not a rejection the server actually
 * reasoned about — re-sending audio it already refused just produces the
 * same refusal. A slow/flaky mobile network can drop a request that would
 * have gone through a moment later, so this is two retries with backoff
 * rather than one flat one.
 */
const RETRY_DELAYS_MS = [600, 1800];

/**
 * Hard ceiling on one upload attempt.
 *
 * Without this a fetch has no deadline at all: a mobile connection that stalls
 * mid-upload leaves the promise pending, the recorder stuck in "processing",
 * and the learner staring at "Scoring…" forever with no way back except a
 * reload. A dropped connection rejects quickly; a *stalled* one does not, and
 * that is the common failure on a train or in a lift.
 *
 * Sized for the slow case rather than the fast one. A 4s take is ~130 kB of
 * 16 kHz PCM, which is several seconds on a poor connection, and the server
 * then allows Azure up to 8s (RECOGNITION_TIMEOUT_MS) before giving up. 25s
 * leaves room for both plus the response, while still being decisively short
 * of "forever".
 */
const UPLOAD_TIMEOUT_MS = 25_000;

export class ScoringError extends Error {
  readonly code: string;
  readonly domain: "client" | "network" | "server" | "provider" | "model";
  readonly userMessage: string;

  constructor(code: string, domain: ScoringError["domain"], message: string, userMessage: string) {
    super(message);
    this.name = "ScoringError";
    this.code = code;
    this.domain = domain;
    this.userMessage = userMessage;
  }
}

export interface ScoreRequest {
  wav: Blob;
  referenceText: string;
  language: string;
  contextSampleRate: number;
  granted: GrantedConstraints;
  /** Ties every attempt in a session together — see ActivityTest.tsx. */
  sessionId: string;
  activityId: number;
  snrDb: number;
  peakDbfs: number;
  endpoint: DeviceContext["endpoint"];
  /** Whatever the learner entered on the language picker, if anything. */
  learnerName?: string;
}

export async function scoreRecording(req: ScoreRequest): Promise<PronunciationResult> {
  const deviceContext: DeviceContext = {
    ua: navigator.userAgent,
    contextRate: req.contextSampleRate,
    granted: req.granted,
    snrDb: req.snrDb,
    peakDbfs: req.peakDbfs,
    endpoint: req.endpoint,
    connection: readConnectionInfo(),
  };

  const form = new FormData();
  form.append("audio", req.wav, "capture.wav");
  form.append("referenceText", req.referenceText);
  form.append("language", req.language);
  form.append("sessionId", req.sessionId);
  form.append("activityId", String(req.activityId));
  if (req.learnerName) form.append("learnerName", req.learnerName);
  form.append("deviceContext", JSON.stringify(deviceContext));

  const startedAt = performance.now();
  let attempt = 0;
  const reportTiming = (outcome: "success" | "failure"): void => {
    // Can't be embedded in deviceContext above — this request's own duration
    // isn't knowable until after it's sent. Reported after the fact instead,
    // via the same fire-and-forget endpoint useCaptureToasts.ts already
    // posts errors to, correlated by session/activity like everything else.
    void fetch("/api/v1/diagnostics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: "SCORE_TIMING",
        domain: "network",
        message: outcome,
        sessionId: req.sessionId,
        activityId: req.activityId,
        ...(req.learnerName ? { learnerName: req.learnerName } : {}),
        context: { uploadMs: Math.round(performance.now() - startedAt), retryCount: attempt, outcome },
      }),
    }).catch(() => undefined);
  };

  // Fail fast rather than let a request sit until it times out — a browser
  // network stack can take 10s+ to notice and reject a fetch while offline.
  if (!navigator.onLine) {
    reportTiming("failure");
    throw new ScoringError(
      "OFFLINE",
      "network",
      "navigator.onLine is false",
      "You're offline. Reconnect and try again.",
    );
  }

  for (;;) {
    try {
      const result = await post(form);
      reportTiming("success");
      return result;
    } catch (err) {
      /**
       * Retry a connection that dropped, never one we abandoned on a deadline.
       * UPLOAD_TIMEOUT keeps domain "network" because that is honestly what it
       * is, but it is excluded here on cost grounds: a fetch that rejects
       * immediately never reached the scorer, while one still pending after
       * 25s may already have called and been billed by Azure. Re-sending that
       * automatically would double-charge on exactly the flaky connections
       * where it happens most. The learner can retry deliberately.
       */
      const retryable =
        err instanceof ScoringError && err.domain === "network" && err.code !== "UPLOAD_TIMEOUT";
      const retryDelayMs = retryable ? RETRY_DELAYS_MS[attempt] : undefined;
      if (retryDelayMs === undefined) {
        reportTiming("failure");
        throw err;
      }
      attempt += 1;
      await delay(retryDelayMs);
    }
  }
}

async function post(form: FormData): Promise<PronunciationResult> {
  let response: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  try {
    response = await fetch(ENDPOINT, { method: "POST", body: form, signal: controller.signal });
  } catch (err) {
    // Excluded from the retry loop above on cost grounds — see the comment there.
    if (controller.signal.aborted) {
      throw new ScoringError(
        "UPLOAD_TIMEOUT",
        "network",
        `upload exceeded ${UPLOAD_TIMEOUT_MS} ms`,
        "That took too long to send — the connection looks slow. Tap to try again.",
      );
    }
    throw new ScoringError(
      "NETWORK_FAILED",
      "network",
      `fetch failed: ${String(err)}`,
      "Couldn't reach the server. Check your connection and try again.",
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    if (body?.error) {
      throw new ScoringError(body.error.code, body.error.domain, body.error.message, body.error.userMessage);
    }
    throw new ScoringError(
      "HTTP_ERROR",
      response.status >= 500 ? "server" : "client",
      `HTTP ${response.status}`,
      "Scoring failed. Please try again.",
    );
  }

  try {
    return (await response.json()) as PronunciationResult;
  } catch (err) {
    throw new ScoringError(
      "BAD_RESPONSE",
      "server",
      `unparseable response: ${String(err)}`,
      "Scoring returned something unexpected. Please try again.",
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * navigator.connection — Chromium only. Safari (iOS and macOS) never
 * implements the Network Information API at all; "not reported" there is a
 * real platform fact, not a failed read, same convention GrantedConstraints
 * already uses for a DSP setting Safari doesn't expose.
 */
function readConnectionInfo(): DeviceContext["connection"] {
  const nav = navigator as Navigator & {
    connection?: { effectiveType?: string; downlink?: number; rtt?: number };
  };
  const c = nav.connection;
  if (!c || typeof c.effectiveType !== "string") return "not reported";
  return {
    effectiveType: c.effectiveType,
    downlinkMbps: typeof c.downlink === "number" ? c.downlink : -1,
    rttMs: typeof c.rtt === "number" ? c.rtt : -1,
  };
}
