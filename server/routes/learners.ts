/**
 * Registering a learner and rotating their token.
 *
 * Two endpoints, no login screen. The client mints its own id and posts it
 * here; the server records it and returns a signed token. That token is what
 * authorises later requests — the bare id authorises nothing, because anyone
 * can send anyone's id.
 */

import { Router } from "express";
import { issueToken, isLearnerId } from "../identity.js";
import { registerLearner, deleteLearner } from "../store/learners.js";
import { deleteProgress } from "../store/progress.js";
import { deleteSkills } from "../store/skills.js";
import { deleteStreak } from "../store/streaks.js";
import { deleteAttemptsFor } from "../attempts.js";
import { deleteDiagnosticsFor } from "../diagnostics.js";
import { deleteRateLimitsFor } from "../rateLimitStore.js";
import { learnerIdFrom, requireLearner } from "../middleware/identity.js";
import { diagnosticsLimiter } from "../rateLimit.js";
import { isAppError } from "../errors.js";
import { logger } from "../logger.js";
import { increment } from "../infra/metrics.js";

export const learnersRouter = Router();

/**
 * Rate-limited with the diagnostics ceiling rather than its own.
 *
 * These calls cost nothing external, so the limit is about abuse volume rather
 * than billing — which is exactly what that limiter is for. A third namespace
 * would be a third budget to reason about for no gain.
 */
learnersRouter.post("/learners", diagnosticsLimiter, (req, res) => {
  const body = req.body as { learnerId?: unknown; displayName?: unknown; locale?: unknown };

  // Validated here as well as inside issueToken. The token layer refuses to
  // sign a bad id, but this returns the right error to the right party — a
  // malformed id is the client's mistake, not a server fault.
  if (!isLearnerId(body.learnerId)) {
    res.status(400).json({
      error: {
        code: "INVALID_REQUEST",
        domain: "client",
        message: "learnerId must be a v4 UUID",
        userMessage: "Could not set up this device. Please reload and try again.",
      },
    });
    return;
  }

  const learnerId = body.learnerId;

  try {
    // Issued before the write, so a database problem cannot be reported as an
    // authentication problem — and so the ordering of the two failures stays
    // obvious in the log.
    const token = issueToken(learnerId);
    increment("identity.registered");

    void registerLearner(learnerId, body.displayName, body.locale).catch((err: unknown) => {
      // The token is already valid, and the learner can practise. The record
      // will be created by the next sync, so failing the request here would
      // cost the learner a session to save us a row.
      logger.error({ err }, "[learners] failed to record a registration");
    });

    res.json({ token });
  } catch (err) {
    if (isAppError(err)) {
      res.status(err.status).json({ error: err.toJSON() });
      return;
    }
    throw err;
  }
});

/**
 * Rotates the token, keeping the same learner.
 *
 * Bounds how long a leaked token stays useful without ever asking a learner to
 * re-enter something they do not have. The old token keeps working until it
 * expires — revoking it would require server-side token state, which is a
 * session store, which is the thing this design is avoiding.
 */
learnersRouter.post("/learners/rotate", diagnosticsLimiter, requireLearner, (_req, res) => {
  const learnerId = learnerIdFrom(res);
  if (learnerId === null) {
    // Unreachable behind requireLearner. Handled rather than asserted, because
    // an assertion here would be a crash in the authentication path.
    res.status(401).json({
      error: {
        code: "UNAUTHENTICATED",
        domain: "client",
        message: "no learner on the request",
        userMessage: "Please reload the page and try again.",
      },
    });
    return;
  }

  res.json({ token: issueToken(learnerId) });
});

/**
 * Erases everything this server holds about the learner.
 *
 * The technical half of a deletion request, and it had no implementation in
 * any form — which meant the privacy posture was a document describing
 * something that could not be done.
 *
 * All six collections, and the count from each is returned. That is
 * deliberate: a deletion that reports what it removed can be verified, and a
 * silent 204 is indistinguishable from a deletion that quietly missed a
 * collection somebody added later.
 *
 * Sequential rather than parallel. If one collection fails, the ones before it
 * are already gone and the client can retry — deletion is idempotent, so a
 * retry costs nothing. Run in parallel, a partial failure would leave an
 * arbitrary subset removed with no way to know which.
 *
 * Two honest limits, both consequences of letting people practise without
 * registering. An anonymous attempt carries no learner id, so nobody can find
 * it — not us, and not the learner asking; those expire on the TTL. And the
 * token is not revoked, because there is no server-side token state to revoke
 * it from: a learner who deletes and keeps using the same browser will simply
 * start accumulating a new record under the same id.
 */
learnersRouter.delete("/learners/me", diagnosticsLimiter, requireLearner, (_req, res) => {
  const learnerId = learnerIdFrom(res);
  if (learnerId === null) {
    res.status(401).json({
      error: {
        code: "UNAUTHENTICATED",
        domain: "client",
        message: "no learner on the request",
        userMessage: "Please reload the page and try again.",
      },
    });
    return;
  }

  void (async (): Promise<void> => {
    try {
      const attempts = await deleteAttemptsFor(learnerId);
      const diagnostics = await deleteDiagnosticsFor(learnerId);
      /**
       * Rate-limit windows too. They expire on their own within minutes, but
       * their ids contain the learner id now that a limiter keys on it — and a
       * deletion promise with an asterisk is not worth keeping.
       */
      await deleteRateLimitsFor(learnerId);
      await deleteProgress(learnerId);
      await deleteSkills(learnerId);
      await deleteStreak(learnerId);
      // Last, so a failure earlier leaves the learner record present and the
      // retry can still find everything by the same id.
      await deleteLearner(learnerId);

      logger.warn({ learnerId, attempts, diagnostics }, "[learners] erased a learner on request");
      res.json({ deleted: true, attempts, diagnostics });
    } catch (err) {
      logger.error({ err, learnerId }, "[learners] deletion failed part-way");
      res.status(503).json({
        error: {
          code: "PROVIDER_UNAVAILABLE",
          domain: "server",
          message: "deletion did not complete",
          // Says the true thing: some may be gone, and retrying is safe and
          // is what finishes the job.
          userMessage: "Your data was not fully deleted. Please try again.",
        },
      });
    }
  })();
});
