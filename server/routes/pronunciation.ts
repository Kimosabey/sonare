/**
 * FR-12 — POST /api/v1/pronunciation
 *
 * multipart: audio (WAV), referenceText, language, deviceContext (JSON string).
 * Returns exactly the PRD §6 shape, whichever provider produced it.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { uploadAudio } from "../middleware/upload.js";
import { getScoringProvider } from "../services/index.js";
import { AppError, isAppError } from "../errors.js";
import { assertAzureFormat, assertDuration, inspectWav } from "../wav.js";
import { recordAttempt } from "../attempts.js";
import { recordDiagnostic } from "../diagnostics.js";
import { scoringLimiter } from "../rateLimit.js";
import type { PronunciationResult } from "../services/types.js";

const MIN_AUDIO_SECONDS = Number(process.env.MIN_AUDIO_SECONDS ?? 0.25);
const MAX_AUDIO_SECONDS = Number(process.env.MAX_AUDIO_SECONDS ?? 15);

export const pronunciationRouter = Router();

pronunciationRouter.post("/pronunciation", scoringLimiter, (req: Request, res: Response) => {
  uploadAudio(req, res, (uploadErr: unknown) => {
    if (uploadErr) {
      const tooBig =
        typeof uploadErr === "object" &&
        uploadErr !== null &&
        "code" in uploadErr &&
        (uploadErr as { code?: string }).code === "LIMIT_FILE_SIZE";

      return respondWithError(
        req,
        res,
        new AppError({
          code: tooBig ? "AUDIO_TOO_LONG" : "MISSING_AUDIO",
          domain: "client",
          message: `upload rejected: ${String(uploadErr)}`,
          userMessage: tooBig
            ? "That recording was too long. Try just the phrase on its own."
            : "No audio was received. Please try again.",
        }),
      );
    }

    void handleScoring(req, res);
  });
});

async function handleScoring(req: Request, res: Response): Promise<void> {
  const startedAt = process.hrtime.bigint();

  try {
    const file = req.file;
    if (!file?.buffer?.length) {
      throw new AppError({
        code: "MISSING_AUDIO",
        domain: "client",
        message: "no audio part in the request",
        userMessage: "No audio was received. Please try again.",
      });
    }

    const body = req.body as Record<string, unknown>;
    const referenceText = typeof body.referenceText === "string" ? body.referenceText.trim() : "";
    const language = typeof body.language === "string" && body.language ? body.language : "en-US";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
    const activityId = typeof body.activityId === "string" ? Number(body.activityId) : undefined;
    const learnerName = typeof body.learnerName === "string" && body.learnerName ? body.learnerName : undefined;

    if (!referenceText) {
      throw new AppError({
        code: "MISSING_REFERENCE_TEXT",
        domain: "client",
        message: "referenceText is required",
        userMessage: "No target phrase was supplied.",
      });
    }

    // FR-19: content type, sample rate, duration — validated, not trusted.
    if (file.mimetype && !/^audio\/(wav|x-wav|wave|vnd\.wave)$/i.test(file.mimetype)) {
      throw new AppError({
        code: "BAD_CONTENT_TYPE",
        domain: "client",
        message: `unexpected content type: ${file.mimetype}`,
        userMessage: "That recording was in an unexpected format. Please try again.",
      });
    }

    const info = inspectWav(file.buffer);
    assertAzureFormat(info);
    assertDuration(info, MIN_AUDIO_SECONDS, MAX_AUDIO_SECONDS);

    const provider = getScoringProvider();

    const providerStart = process.hrtime.bigint();
    const result: PronunciationResult = await provider.score(file.buffer, referenceText, language);
    const providerMs = msSince(providerStart);
    const totalMs = msSince(startedAt);

    res.json(result);

    // FR-18. After responding — persistence must never add latency to the learner.
    await recordAttempt({
      at: new Date().toISOString(),
      ...(sessionId ? { sessionId } : {}),
      ...(activityId !== undefined && !Number.isNaN(activityId) ? { activityId } : {}),
      ...(learnerName ? { learnerName } : {}),
      referenceText,
      language,
      provider: result.provider,
      ...(result.modelVersion ? { modelVersion: result.modelVersion } : {}),
      deviceContext: parseDeviceContext(body.deviceContext),
      audio: {
        bytes: file.buffer.length,
        seconds: Number(info.seconds.toFixed(3)),
        sampleRate: info.sampleRate,
        channels: info.channels,
        bitsPerSample: info.bitsPerSample,
      },
      timings: { providerMs, totalMs },
      result,
    });
  } catch (err) {
    respondWithError(req, res, err);
  }
}

function msSince(start: bigint): number {
  return Math.round(Number(process.hrtime.bigint() - start) / 1e6);
}

function parseDeviceContext(raw: unknown): unknown {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { unparsed: raw.slice(0, 500) };
  }
}

function respondWithError(req: Request, res: Response, err: unknown): void {
  if (res.headersSent) return;

  const context = { userAgent: req.headers["user-agent"] ?? "not reported" };
  // req.body may be partially populated (or absent) if the upload itself
  // was what failed — read defensively rather than assuming the normal shape.
  const body = (req.body as Record<string, unknown> | undefined) ?? {};
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
  const rawActivityId = typeof body.activityId === "string" ? Number(body.activityId) : undefined;
  const activityId = rawActivityId !== undefined && !Number.isNaN(rawActivityId) ? rawActivityId : undefined;
  const learnerName = typeof body.learnerName === "string" && body.learnerName ? body.learnerName : undefined;

  if (isAppError(err)) {
    // Server-side detail is logged; the client sees code, domain and userMessage.
    // No branch of this ever includes a credential — R2.
    console.error(`[pronunciation] ${err.code} (${err.domain}): ${err.message}`);
    void recordDiagnostic({
      at: new Date().toISOString(),
      source: "server",
      code: err.code,
      domain: err.domain,
      message: err.message,
      userMessage: err.userMessage,
      ...(sessionId ? { sessionId } : {}),
      ...(activityId !== undefined ? { activityId } : {}),
      ...(learnerName ? { learnerName } : {}),
      context,
    });
    res.status(err.status).json({ error: err.toJSON() });
    return;
  }

  console.error("[pronunciation] unexpected:", String(err));
  void recordDiagnostic({
    at: new Date().toISOString(),
    source: "server",
    code: "PROVIDER_UNAVAILABLE",
    domain: "server",
    message: String(err),
    ...(sessionId ? { sessionId } : {}),
    ...(activityId !== undefined ? { activityId } : {}),
    context,
  });
  res.status(500).json({
    error: {
      code: "PROVIDER_UNAVAILABLE",
      domain: "server",
      message: "unexpected server error",
      userMessage: "Something went wrong. Please try again.",
    },
  });
}
