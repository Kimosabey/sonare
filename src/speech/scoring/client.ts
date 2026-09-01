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
  };

  const form = new FormData();
  form.append("audio", req.wav, "capture.wav");
  form.append("referenceText", req.referenceText);
  form.append("language", req.language);
  form.append("sessionId", req.sessionId);
  form.append("activityId", String(req.activityId));
  if (req.learnerName) form.append("learnerName", req.learnerName);
  form.append("deviceContext", JSON.stringify(deviceContext));

  // Fail fast rather than let a request sit until it times out — a browser
  // network stack can take 10s+ to notice and reject a fetch while offline.
  if (!navigator.onLine) {
    throw new ScoringError(
      "OFFLINE",
      "network",
      "navigator.onLine is false",
      "You're offline. Reconnect and try again.",
    );
  }

  let attempt = 0;
  for (;;) {
    try {
      return await post(form);
    } catch (err) {
      const retryDelayMs = err instanceof ScoringError && err.domain === "network" ? RETRY_DELAYS_MS[attempt] : undefined;
      if (retryDelayMs === undefined) throw err;
      attempt += 1;
      await delay(retryDelayMs);
    }
  }
}

async function post(form: FormData): Promise<PronunciationResult> {
  let response: Response;
  try {
    response = await fetch(ENDPOINT, { method: "POST", body: form });
  } catch (err) {
    throw new ScoringError(
      "NETWORK_FAILED",
      "network",
      `fetch failed: ${String(err)}`,
      "Couldn't reach the server. Check your connection and try again.",
    );
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
