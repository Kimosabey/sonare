/**
 * Pull and push a learner's own record.
 *
 * The missing return path. Until now audio crossed the network and a score
 * came back, but nothing a learner *accumulated* ever did — so clearing site
 * data destroyed their streak, a second device showed a stranger, and no
 * server-side feature was possible at all.
 *
 * A push is also a pull: the response is the merged state, so one round trip
 * leaves both sides holding the same thing and a client that pushed something
 * stale learns the truth immediately rather than on a later poll.
 *
 * Everything here goes through the domain readers, which validate and clamp
 * rather than trusting the body. That matters more than usual: this data is
 * displayed back to the learner as their own history, so a hostile or broken
 * client would otherwise be writing what the learner is later told about
 * themselves.
 */

import { Router } from "express";
import { requireLearner, learnerIdFrom } from "../middleware/identity.js";
import { diagnosticsLimiter } from "../rateLimit.js";
import { logger } from "../logger.js";
import { increment } from "../infra/metrics.js";
import { readProgressState, readSkillState, readStreakState } from "../domain/merge.js";
import type { ProgressState, SkillState, StreakState } from "../domain/merge.js";
import { mergeAndSaveProgress, readAllProgress } from "../store/progress.js";
import { mergeAndSaveSkills, readAllSkills } from "../store/skills.js";
import { mergeAndSaveStreak, readStreak } from "../store/streaks.js";

export const syncRouter = Router();

const EMPTY_STREAK: StreakState = { days: [], longest: 0 };

export interface SyncSnapshot {
  progress: ProgressState[];
  skills: SkillState[];
  streak: StreakState;
}

/**
 * Bounded so one push cannot ask for unbounded work.
 *
 * Four languages ship today. Twelve leaves room without letting a caller
 * enqueue hundreds of merges, each of which is a read-modify-write with
 * retries — the cheapest denial of service available against this endpoint.
 */
const MAX_LANGUAGES = 12;

async function snapshot(learnerId: string): Promise<SyncSnapshot> {
  // In parallel: three independent documents, and the learner is waiting.
  const [progress, skills, streak] = await Promise.all([
    readAllProgress(learnerId),
    readAllSkills(learnerId),
    readStreak(learnerId),
  ]);

  return { progress, skills, streak: streak ?? EMPTY_STREAK };
}

/**
 * Everything the server holds for this learner.
 *
 * No `?since=` parameter. The whole record is a few kilobytes — sixty date
 * strings, forty activity summaries, a few hundred syllables — so a delta
 * protocol would add a cursor, a tombstone story for deletions, and a class of
 * bug where a client silently misses an update, to save less than one image.
 * Worth revisiting only if the record ever stops being small.
 */
syncRouter.get("/sync", diagnosticsLimiter, requireLearner, (_req, res) => {
  const learnerId = learnerIdFrom(res);
  if (learnerId === null) return;

  increment("sync.pull");
  snapshot(learnerId)
    .then((state) => void res.json(state))
    .catch((err: unknown) => {
      increment("sync.pull.failed");
      logger.error({ err }, "[sync] pull failed");
      res.status(503).json({
        error: {
          code: "PROVIDER_UNAVAILABLE",
          domain: "server",
          message: "could not read learner state",
          userMessage: "Your progress could not be loaded. It is safe on this device.",
        },
      });
    });
});

/**
 * Merges whatever the client says is dirty, and returns the whole record.
 *
 * Each domain is optional, so a client that only changed its streak sends only
 * that. Every merge is independent and commutative, so a partial push is never
 * a partial truth — the domains it left out simply come back unchanged.
 */
syncRouter.post("/sync", diagnosticsLimiter, requireLearner, (req, res) => {
  const learnerId = learnerIdFrom(res);
  if (learnerId === null) return;

  increment("sync.push");
  /**
   * Guarded, not cast. `express.json()` leaves `req.body` undefined for any
   * content type it does not parse, so `body.progress` on a `text/plain` POST
   * threw a TypeError out of the handler — and with no error middleware,
   * Express answered 500 with the exception message and every stack frame,
   * absolute paths included. R2 says no branch of an error response includes
   * internal detail; this was the one path that bypassed every handler that
   * honours it. A client sending the wrong content type is also a 4xx, not a
   * server fault.
   */
  const body: { progress?: unknown; skills?: unknown; streak?: unknown } =
    typeof req.body === "object" && req.body !== null ? req.body : {};

  const progress = Array.isArray(body.progress)
    ? body.progress
        .map(readProgressState)
        .filter((s): s is ProgressState => s !== null)
        .slice(0, MAX_LANGUAGES)
    : [];
  const skills = Array.isArray(body.skills)
    ? body.skills
        .map(readSkillState)
        .filter((s): s is SkillState => s !== null)
        .slice(0, MAX_LANGUAGES)
    : [];
  const streak = body.streak === undefined ? null : readStreakState(body.streak);

  /**
   * Sequential per domain, not one big Promise.all over everything.
   *
   * Two pushes for the same language would otherwise race each other inside a
   * single request and burn the version-conflict retries against themselves.
   * The three domains are different documents, so those run in parallel.
   */
  const work = Promise.all([
    (async () => {
      for (const state of progress) await mergeAndSaveProgress(learnerId, state);
    })(),
    (async () => {
      for (const state of skills) await mergeAndSaveSkills(learnerId, state);
    })(),
    streak === null ? Promise.resolve() : mergeAndSaveStreak(learnerId, streak).then(() => undefined),
  ]);

  work
    // Re-read rather than assembling from the merge results, so the response
    // includes the domains this push did not touch. The client stores the
    // whole thing, and a response missing a domain would read as "empty".
    .then(async () => snapshot(learnerId))
    .then((state) => void res.json(state))
    .catch((err: unknown) => {
      increment("sync.push.failed");
      logger.error({ err, learnerId }, "[sync] push failed");
      res.status(503).json({
        error: {
          code: "PROVIDER_UNAVAILABLE",
          domain: "server",
          message: "could not save learner state",
          // The local write already succeeded, so this is genuinely not a
          // problem the learner needs to act on — say so plainly rather than
          // implying lost work.
          userMessage: "Your progress is saved on this device and will sync later.",
        },
      });
    });
});
