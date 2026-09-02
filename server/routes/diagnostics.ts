/**
 * POST /api/v1/diagnostics — client-side capture/scoring errors, reported
 * fire-and-forget from src/ui/useCaptureToasts.ts. Never anything the
 * learner is waiting on; always responds 204 regardless of whether the
 * write actually succeeded (recordDiagnostic already swallows its own
 * failures). Rate-limited but not token-gated — it's write-only and leaks
 * nothing back to the caller.
 *
 * GET /api/v1/diagnostics and GET /api/v1/attempts — read-only, for the
 * internal #/diagnostics screen. These DO expose real attempt/error data
 * across every session — spoken phrases, device info, session IDs — so they
 * always require DIAGNOSTICS_TOKEN. There is no "unset = open" fallback:
 * that would make a forgotten env var the difference between this being
 * internal-only and being a public export of every learner's data. Set
 * DIAGNOSTICS_TOKEN in .env for local dev too; it's one line.
 */

import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { recordDiagnostic, listDiagnostics } from "../diagnostics.js";
import { listAttempts } from "../attempts.js";
import { getSpendReport } from "../spend.js";
import { diagnosticsLimiter } from "../rateLimit.js";
import { logger } from "../logger.js";

/**
 * Lenient by design, matching this endpoint's own fire-and-forget contract
 * (see the file comment): a malformed field falls back to a safe default
 * rather than rejecting the request — a dropped diagnostic is a worse
 * outcome than one recorded with `code: "UNKNOWN"`.
 */
const DiagnosticBodySchema = z.object({
  code: z.string().optional(),
  domain: z.string().optional(),
  message: z.string().optional(),
  userMessage: z.string().optional(),
  sessionId: z.string().optional(),
  activityId: z.number().optional(),
  learnerName: z.string().optional(),
  context: z.unknown().optional(),
});

export const diagnosticsRouter = Router();

diagnosticsRouter.use(diagnosticsLimiter);

const MAX_LIST_LIMIT = 200;

function parseLimit(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, MAX_LIST_LIMIT);
}

/**
 * Constant-time comparison — a plain `===` leaks how many leading characters
 * matched through response timing. Low real-world risk over a network already
 * dominated by jitter, but cheap enough to close outright rather than argue
 * about how low.
 */
function tokensMatch(provided: string, required: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(required);
  // timingSafeEqual throws on a length mismatch rather than returning false —
  // lengths differing is not itself sensitive (the token's length isn't a
  // secret), so short-circuiting here is safe and avoids the throw.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function requireDiagnosticsToken(req: Request, res: Response, next: NextFunction): void {
  const required = process.env.DIAGNOSTICS_TOKEN;
  const provided = req.headers["x-diagnostics-token"];
  // Fail closed, not open, when it's unset — see the comment above.
  if (required && typeof provided === "string" && tokensMatch(provided, required)) {
    next();
    return;
  }
  res.status(401).json({
    error: required
      ? "missing or invalid diagnostics token"
      : "diagnostics is disabled — set DIAGNOSTICS_TOKEN to enable it",
  });
}

diagnosticsRouter.post("/diagnostics", (req: Request, res: Response) => {
  const parsed = DiagnosticBodySchema.safeParse(req.body);
  const body = parsed.success ? parsed.data : {};

  void recordDiagnostic({
    at: new Date().toISOString(),
    source: "client",
    code: body.code ?? "UNKNOWN",
    domain: body.domain ?? "client",
    message: body.message ?? "",
    ...(body.userMessage ? { userMessage: body.userMessage } : {}),
    ...(body.sessionId ? { sessionId: body.sessionId } : {}),
    ...(body.activityId !== undefined ? { activityId: body.activityId } : {}),
    ...(body.learnerName ? { learnerName: body.learnerName } : {}),
    context: {
      userAgent: req.headers["user-agent"] ?? "not reported",
      ...(typeof body.context === "object" && body.context !== null ? body.context : {}),
    },
  });

  res.status(204).end();
});

diagnosticsRouter.get("/diagnostics", requireDiagnosticsToken, (req: Request, res: Response) => {
  const limit = parseLimit(req.query.limit, 50);
  listDiagnostics(limit)
    .then((records) => res.json({ records }))
    .catch((err: unknown) => {
      logger.error({ err }, "[diagnostics] list failed");
      res.status(503).json({ error: "diagnostics store unavailable" });
    });
});

/**
 * Token-gated like the other reads. It exposes no spoken phrases or device
 * detail — only counts, durations and money — but it is still an aggregate
 * over every learner's activity, and the reason the read endpoints are gated
 * is that they cross sessions.
 */
diagnosticsRouter.get("/spend", requireDiagnosticsToken, (_req: Request, res: Response) => {
  getSpendReport()
    .then((report) => res.json(report))
    .catch((err: unknown) => {
      logger.error({ err }, "[spend] aggregation failed");
      res.status(503).json({ error: "spend store unavailable" });
    });
});

diagnosticsRouter.get("/attempts", requireDiagnosticsToken, (req: Request, res: Response) => {
  const limit = parseLimit(req.query.limit, 50);
  listAttempts(limit)
    .then((records) => res.json({ records }))
    .catch((err: unknown) => {
      logger.error({ err }, "[attempts] list failed");
      res.status(503).json({ error: "attempts store unavailable" });
    });
});
