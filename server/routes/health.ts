/**
 * Liveness, readiness, and the metrics behind them.
 *
 * Three endpoints with deliberately different jobs, because conflating them is
 * how a deployment either never starts or never restarts.
 *
 * `/healthz` answers "is this process alive" and checks **nothing else**. It
 * has to stay true while the database is down: an orchestrator that kills a
 * container because Mongo is unreachable turns one outage into a restart loop
 * across every instance, and scoring still works during a Mongo outage
 * (attempts fail over to a local file).
 *
 * `/readyz` answers "should traffic come here", which is a different question
 * and does check dependencies. A failing readiness probe takes an instance out
 * of rotation without killing it, which is exactly right for a database that
 * will come back.
 *
 * `/metrics` is token-gated, because the counters describe usage volumes and
 * failure rates — not learner content, but not public either. It also carries
 * `alerts`: the four thresholds in infra/alerts.ts, evaluated against the same
 * snapshot served beside them.
 *
 * Why the breach state lives here and not on `/readyz`: a firing alert must
 * never take an instance out of rotation. A high indeterminate rate, a slow
 * provider, an 80%-spent cap and a fallback backlog are all things an operator
 * should see, and none of them is a reason to stop sending traffic to a
 * process that is still scoring — three of the four would be *made worse* by
 * shifting that traffic onto the remaining instances. Readiness answers
 * "should traffic come here"; alerts answer "should somebody look". Different
 * questions, so different endpoints.
 *
 * `/api/v1/health` predates all three and stays as it is. Nothing in the
 * client reads it, but it is a published surface and removing it belongs in a
 * commit about removing it.
 */

import { Router } from "express";
import type { Response } from "express";
import { getDb } from "../db.js";
import { getScoringProvider } from "../services/index.js";
import { identityConfigured } from "../identity.js";
import { snapshot } from "../infra/metrics.js";
import { collectAlerts } from "../infra/alerts.js";
import { countPending } from "../fallbackLog.js";
import type { FallbackCollection } from "../fallbackLog.js";
import { requireDiagnosticsToken } from "./diagnostics.js";

export const healthRouter = Router();

/**
 * Alive. No dependency checks, no database, no provider.
 *
 * Not rate-limited either: a probe that gets 429ed reads as a dead process,
 * and the endpoint does no work worth limiting.
 */
healthRouter.get("/healthz", (_req, res) => {
  res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) });
});

/**
 * Ready for traffic.
 *
 * Mongo is checked with a ping rather than by whether `getDb()` resolves —
 * the connection is cached, so a resolved promise only proves it connected
 * once. A ping proves it is answering now, which is the question.
 *
 * Returns 503 with the detail rather than 200-with-a-flag, so an orchestrator
 * reading only the status code gets the right answer without parsing.
 */
healthRouter.get("/readyz", (_req, res) => {
  void (async (): Promise<void> => {
    let database: boolean;
    try {
      const db = await getDb();
      await db.command({ ping: 1 });
      database = true;
    } catch {
      database = false;
    }

    let provider = true;
    try {
      // Throws MISCONFIGURED when no vendor is usable, which is the provider's
      // own judgement rather than a list of env-var names this file would have
      // to keep in step (R12).
      getScoringProvider();
    } catch {
      provider = false;
    }

    const identity = identityConfigured();
    /**
     * Identity being off is reported but does not make the instance
     * unready. Scoring works without it — a learner who has never registered
     * must still be able to practise — so refusing traffic would take the
     * product down over a feature that is optional by design.
     */
    const ready = database && provider;

    res.status(ready ? 200 : 503).json({ ready, database, provider, identity });
  })();
});

/**
 * Counters, latency percentiles, and the four thresholds evaluated over them.
 *
 * Token-gated with the same token the diagnostics screen uses, and with the
 * same rule: there is no "unset means open".
 */
healthRouter.get("/metrics", requireDiagnosticsToken, (_req, res) => {
  /**
   * `fallbackPending` is read from disk, not from a counter, and that
   * distinction is the whole point of including it.
   *
   * `fallback.written` counts writes since this process started, so a restart
   * with a full backlog reports zero — and the moment somebody most wants to
   * know there is unreplayed learner data is right after the restart that
   * ended the outage. This asks the filesystem, so it is true regardless of
   * how many times the process has come and gone.
   *
   * The one figure here that means an outage has already happened, which is
   * why one of the four alert rules watches it.
   */
  void countPending().then(
    (fallbackPending) => respondWithMetrics(res, fallbackPending),
    // A metrics endpoint that fails because it could not stat a file is worse
    // than one missing a field. Null travels through to the alert rule as
    // `unknown` rather than as "no backlog", because a directory that cannot
    // be read is not evidence of an empty one.
    () => respondWithMetrics(res, null),
  );
});

/**
 * One snapshot, served and evaluated.
 *
 * Taken once and handed to both, so the breach state in the response describes
 * the very figures in the response. Calling `snapshot()` again for the alerts
 * would let a request that lands mid-attempt report a rate the alerts never
 * saw — a small window, and a payload nobody could reason from when it hit.
 */
function respondWithMetrics(res: Response, fallbackPending: Record<FallbackCollection, number> | null): void {
  const metrics = snapshot();
  /**
   * `collectAlerts` is written not to reject — an unreadable spend figure is
   * an `unknown` rule rather than a failed response. The rejection handler is
   * here anyway because the failure it would otherwise produce is the worst
   * available shape: no `res.json` call at all, so the request hangs until the
   * caller's own deadline and the only trace is an unhandled rejection.
   *
   * `alerts: null` rather than an empty report, for the same reason a null
   * rate is not a zero one. "Not evaluated" and "nothing firing" must not look
   * alike, and the counters beside it are still true.
   */
  void collectAlerts(metrics, fallbackPending).then(
    (alerts) => void res.json({ ...metrics, fallbackPending, alerts }),
    () => void res.json({ ...metrics, fallbackPending, alerts: null }),
  );
}
