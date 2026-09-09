/**
 * POST /api/v1/diagnostics — client-side capture/scoring errors, reported
 * fire-and-forget from src/hooks/useCaptureToasts.ts. Never anything the
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
 *
 * Both of those reads take `?learnerId=` to narrow to one person, which is
 * the question a support ticket actually asks. It is strictly less data per
 * response than the unfiltered read already served and sits behind exactly
 * the same requireDiagnosticsToken gate — no second auth scheme, no separate
 * route, nothing reachable that this token could not already reach. What is
 * new is the ability to *ask about a named person*, which is both the point
 * and the reason it stays token-only.
 */

import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { recordDiagnostic, listDiagnostics, listDiagnosticsFor } from "../diagnostics.js";
import { learnerIdFrom, optionalLearner } from "../middleware/identity.js";
import { isLearnerId } from "../identity.js";
import { listAttempts, listAttemptsFor } from "../attempts.js";
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
 * Absent, one learner, or refuse the request.
 *
 * There is deliberately no fourth case where a `learnerId` we could not make
 * sense of is dropped and the unfiltered read runs instead. A responder who
 * asked about one person and silently got back *everyone* is the worst
 * available outcome: it widens the response rather than narrowing it, and it
 * hands them another learner's failures to draw a conclusion about this one
 * from. Narrowing endpoints must never fail open, so an unusable value is a
 * 400 and the store is never touched.
 *
 * `isLearnerId` does the checking rather than a `typeof === "string"` test,
 * because it is the same predicate identity.ts applies before signing an id
 * and it rejects two separate shapes of trouble at once:
 *
 *  - **Not a string.** `?learnerId=a&learnerId=b` parses to `["a","b"]` on
 *    this Express version. As a Mongo filter that matches nothing and would
 *    report "no records" for a learner who has plenty — a wrong answer that
 *    reads like a finding. Bracket notation (`?learnerId[$ne]=x`) is inert
 *    under Express 5's default `simple` query parser, which returns
 *    `undefined` for it, but it parses to `{ $ne: "x" }` the moment anyone
 *    sets `query parser` to `extended` — and `{ learnerId: { $ne: "x" } }` is
 *    every learner *but* one, out of an endpoint whose entire purpose is
 *    narrowing to a single one. The guard does not depend on which parser is
 *    configured.
 *  - **Not a learner id.** A UUID shape means a typo, a truncated paste or a
 *    display name typed into the box gets told so, instead of coming back as
 *    a confident empty result.
 */
type LearnerFilter = { ok: true; learnerId: string | null } | { ok: false };

function parseLearnerFilter(raw: unknown): LearnerFilter {
  if (raw === undefined) return { ok: true, learnerId: null };
  if (isLearnerId(raw)) return { ok: true, learnerId: raw };
  return { ok: false };
}

/** The one refusal shape both reads share. */
function rejectLearnerId(res: Response): void {
  res.status(400).json({ error: "learnerId must be a learner id" });
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

/**
 * Exported so the metrics endpoint shares this guard rather than copying it.
 * A second implementation is a second place for the "unset means open"
 * mistake this one exists to prevent.
 */
export function requireDiagnosticsToken(req: Request, res: Response, next: NextFunction): void {
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

/**
 * `optionalLearner`, so a report from an unregistered learner still lands —
 * a capture failure is most useful precisely when something is wrong, which
 * includes identity. The id is attached when it is there so a deletion
 * request can later reach these records.
 */
diagnosticsRouter.post("/diagnostics", optionalLearner, (req: Request, res: Response) => {
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
    ...(learnerIdFrom(res) !== null ? { learnerId: learnerIdFrom(res) as string } : {}),
    context: {
      userAgent: req.headers["user-agent"] ?? "not reported",
      ...(typeof body.context === "object" && body.context !== null ? body.context : {}),
    },
  });

  res.status(204).end();
});

diagnosticsRouter.get("/diagnostics", requireDiagnosticsToken, (req: Request, res: Response) => {
  const limit = parseLimit(req.query.limit, 50);
  const learner = parseLearnerFilter(req.query.learnerId);
  if (!learner.ok) return rejectLearnerId(res);

  const read =
    learner.learnerId === null ? listDiagnostics(limit) : listDiagnosticsFor(learner.learnerId, limit);
  read
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
  const learner = parseLearnerFilter(req.query.learnerId);
  if (!learner.ok) return rejectLearnerId(res);

  const read = learner.learnerId === null ? listAttempts(limit) : listAttemptsFor(learner.learnerId, limit);
  read
    .then((records) => res.json({ records }))
    .catch((err: unknown) => {
      logger.error({ err }, "[attempts] list failed");
      res.status(503).json({ error: "attempts store unavailable" });
    });
});
