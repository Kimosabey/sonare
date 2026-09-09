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
import { registerLearner, deleteLearner, findLearner } from "../store/learners.js";
import { deleteProgress, readAllProgress } from "../store/progress.js";
import { deleteSkills, readAllSkills } from "../store/skills.js";
import { deleteStreak, readStreak } from "../store/streaks.js";
import { deleteAttemptsFor, listAttemptsFor } from "../attempts.js";
import { deleteDiagnosticsFor, listDiagnosticsFor } from "../diagnostics.js";
import { deleteRateLimitsFor, listRateLimitsFor } from "../rateLimitStore.js";
import { learnerIdFrom, requireLearner } from "../middleware/identity.js";
import { diagnosticsLimiter } from "../rateLimit.js";
import { isAppError } from "../errors.js";
import { logger } from "../logger.js";
import { increment } from "../infra/metrics.js";

export const learnersRouter = Router();

/**
 * Every collection that can hold something about one learner.
 *
 * One list, and it is the contract between the two halves of a data request:
 * the export below is typed as a record over exactly these names, so a
 * collection added to the deletion path and forgotten here is a *compile*
 * error rather than a quietly incomplete export. The route test asserts the
 * other direction — that the delete handler touches exactly this set — so
 * neither half can drift from the other unnoticed.
 *
 * That mattering is not hypothetical. `ratelimits` is on this list because a
 * limiter started keying on the learner, which put learner ids into rate-limit
 * document ids, and a deletion that knew nothing about the collection left
 * them behind. The end-to-end test asserts that *no* stored document mentions
 * the learner, deliberately phrased so a collection added later is swept into
 * the same assertion; this list is the same idea for the export.
 */
export const LEARNER_COLLECTIONS = [
  "attempts",
  "diagnostics",
  "ratelimits",
  "progress",
  "skills",
  "streaks",
  "learners",
] as const;

type LearnerCollection = (typeof LEARNER_COLLECTIONS)[number];

/**
 * Keys are Mongo collection names, so `streaks` and `learners` hold a single
 * document rather than a list. Naming them for the collection rather than for
 * the shape is what makes the agreement above checkable at all.
 */
type ExportedCollections = Record<LearnerCollection, unknown>;

/**
 * Per-collection cap on the two unbounded trails.
 *
 * An export has to terminate, and the attempt trail grows with every take. A
 * cap that silently drops the oldest records would make the export a partial
 * copy claiming to be a whole one, so the response says which collections were
 * cut — see `truncated` below. Exported so the test can reach the boundary
 * without hard-coding the number in two places.
 */
export const EXPORT_MAX_RECORDS = 2000;

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
 * Everything this server holds about the learner, as JSON.
 *
 * The smaller half of a data request, and it was missing entirely: a learner
 * could have their record erased but never see it, so the only way to find out
 * what was held about them was to ask somebody with database access.
 *
 * Covers the same collections the deletion below erases, by construction —
 * `collections` is typed as a record over `LEARNER_COLLECTIONS`, so it cannot
 * be missing one. The two features answering different questions about what
 * "everything" means would leave the learner unable to check the deletion
 * against anything, which is most of the value of reporting counts at all.
 *
 * In parallel, unlike the deletion. A read has no ordering constraint and
 * nothing to leave half-done: a failure anywhere fails the whole response and
 * the learner retries, where a deletion run in parallel would leave an
 * arbitrary subset removed with no way to know which.
 *
 * Two honest limits, the same two the deletion has. An anonymous attempt
 * carries no learner id, so it cannot be found by anyone — not us and not the
 * learner asking. And no audio: none is stored per learner anywhere, so there
 * is none to hand back. The attempt records carry the *shape* of each
 * recording (bytes, seconds, sample rate) and never the recording.
 */
learnersRouter.get("/learners/me/export", diagnosticsLimiter, requireLearner, (_req, res) => {
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
      const [attempts, diagnostics, ratelimits, progress, skills, streaks, learner] =
        await Promise.all([
          // One over the cap, so truncation is detected without a second
          // count query — and reported rather than left for the learner to
          // notice their history stops at a round number.
          listAttemptsFor(learnerId, EXPORT_MAX_RECORDS + 1),
          listDiagnosticsFor(learnerId, EXPORT_MAX_RECORDS + 1),
          listRateLimitsFor(learnerId),
          readAllProgress(learnerId),
          readAllSkills(learnerId),
          readStreak(learnerId),
          findLearner(learnerId),
        ]);

      const collections: ExportedCollections = {
        attempts: attempts.slice(0, EXPORT_MAX_RECORDS),
        diagnostics: diagnostics.slice(0, EXPORT_MAX_RECORDS),
        ratelimits,
        progress,
        skills,
        streaks,
        learners: learner,
      };

      logger.info({ learnerId }, "[learners] exported a learner on request");
      res.json({
        /** Bumped if the shape changes, so a saved file stays readable. */
        format: 1,
        exportedAt: new Date().toISOString(),
        learnerId,
        collections,
        truncated: {
          attempts: attempts.length > EXPORT_MAX_RECORDS,
          diagnostics: diagnostics.length > EXPORT_MAX_RECORDS,
        },
      });
    } catch (err) {
      logger.error({ err, learnerId }, "[learners] export failed");
      res.status(503).json({
        error: {
          code: "PROVIDER_UNAVAILABLE",
          domain: "server",
          message: "export did not complete",
          // A partial export presented as a whole one would be worse than
          // none, so nothing is returned and retrying is the whole remedy.
          userMessage: "Your data could not be exported. Please try again.",
        },
      });
    }
  })();
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
