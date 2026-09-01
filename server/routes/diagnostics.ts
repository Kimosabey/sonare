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
 * across every session, so they're gated behind DIAGNOSTICS_TOKEN if it's
 * set. Left optional (unset = open) so local dev needs no setup — set it
 * before this server is ever reachable outside a dev machine (see README).
 */

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { recordDiagnostic, listDiagnostics } from "../diagnostics.js";
import { listAttempts } from "../attempts.js";
import { diagnosticsLimiter } from "../rateLimit.js";

export const diagnosticsRouter = Router();

diagnosticsRouter.use(diagnosticsLimiter);

const MAX_LIST_LIMIT = 200;

function parseLimit(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, MAX_LIST_LIMIT);
}

function requireDiagnosticsToken(req: Request, res: Response, next: NextFunction): void {
  const required = process.env.DIAGNOSTICS_TOKEN;
  if (!required) {
    next(); // Not configured — stays open, matching local-dev-by-default.
    return;
  }
  if (req.headers["x-diagnostics-token"] === required) {
    next();
    return;
  }
  res.status(401).json({ error: "missing or invalid diagnostics token" });
}

diagnosticsRouter.post("/diagnostics", (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;

  void recordDiagnostic({
    at: new Date().toISOString(),
    source: "client",
    code: typeof body.code === "string" ? body.code : "UNKNOWN",
    domain: typeof body.domain === "string" ? body.domain : "client",
    message: typeof body.message === "string" ? body.message : "",
    ...(typeof body.userMessage === "string" ? { userMessage: body.userMessage } : {}),
    ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
    ...(typeof body.activityId === "number" ? { activityId: body.activityId } : {}),
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
      console.error("[diagnostics] list failed:", String(err));
      res.status(503).json({ error: "diagnostics store unavailable" });
    });
});

diagnosticsRouter.get("/attempts", requireDiagnosticsToken, (req: Request, res: Response) => {
  const limit = parseLimit(req.query.limit, 50);
  listAttempts(limit)
    .then((records) => res.json({ records }))
    .catch((err: unknown) => {
      console.error("[attempts] list failed:", String(err));
      res.status(503).json({ error: "attempts store unavailable" });
    });
});
