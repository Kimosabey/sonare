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
 * failure rates — not learner content, but not public either.
 *
 * `/api/v1/health` predates all three and stays as it is. Nothing in the
 * client reads it, but it is a published surface and removing it belongs in a
 * commit about removing it.
 */

import { Router } from "express";
import { getDb } from "../db.js";
import { getScoringProvider } from "../services/index.js";
import { identityConfigured } from "../identity.js";
import { snapshot } from "../infra/metrics.js";
import { countPending } from "../fallbackLog.js";
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
 * Counters, latency percentiles and the rates worth alerting on.
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
   * The one figure here worth alerting on.
   */
  void countPending()
    .then((fallbackPending) => void res.json({ ...snapshot(), fallbackPending }))
    .catch(() => {
      // A metrics endpoint that fails because it could not stat a file is
      // worse than one missing a field.
      res.json({ ...snapshot(), fallbackPending: null });
    });
});
