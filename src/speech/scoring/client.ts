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

/** One retry, for a dropped connection only. */
const RETRY_DELAY_MS = 600;

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
  /** Ties every attempt in a session together — see FrenchActivityTest.tsx. */
  sessionId: string;
  activityId: number;
  snrDb: number;
  peakDbfs: number;
  endpoint: DeviceContext["endpoint"];
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
  form.append("deviceContext", JSON.stringify(deviceContext));

  try {
    return await post(form);
  } catch (err) {
    // Retry the network, never a rejection the server actually reasoned about —
    // re-sending audio it already refused just produces the same refusal.
    if (err instanceof ScoringError && err.domain === "network") {
      await delay(RETRY_DELAY_MS);
      return post(form);
    }
    throw err;
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
