/**
 * FR-18 — an attempt record per scoring call, persisted to MongoDB.
 *
 * Audio itself is not persisted — nothing in the PRD asks for it, and storing
 * learner voice recordings is a data-protection decision, not a build one.
 */

import { getDb } from "./db.js";
import { appendFallback } from "./fallbackLog.js";
import { logger } from "./logger.js";
import type { PronunciationResult } from "./services/types.js";
import type { Alignment } from "./alignment.js";
import type { VerdictComparison } from "./verdicts.js";

export interface AttemptRecord {
  at: string;
  /** Ties every attempt/diagnostic in one session together for funnel analysis. */
  sessionId?: string;
  activityId?: number;
  /** Self-reported on the language picker — identifies a person, not just a session. */
  learnerName?: string;
  /**
   * The signed, anonymous learner id (identity.ts), when the request carried a
   * valid token.
   *
   * Kept alongside `learnerName` rather than replacing it: the name is what a
   * learner typed and is what a human reading the trail recognises, while this
   * is the only field that actually identifies anyone reliably. Optional
   * because scoring deliberately works without a token — a learner who has not
   * registered must still be able to practise.
   */
  learnerId?: string;
  referenceText: string;
  language: string;
  provider: string;
  modelVersion?: string;
  /** Whatever the client reported: user agent, context rate, granted constraints. */
  deviceContext: unknown;
  audio: {
    bytes: number;
    seconds: number;
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
  };
  timings: {
    providerMs: number;
    totalMs: number;
  };
  result: PronunciationResult;
  /**
   * Our own expected-versus-heard verdict, alongside the provider's.
   *
   * Deliberately *not* folded into `result`. That type is the §6 provider
   * contract — R12 says nothing outside server/services/ may know which
   * vendor produced it, and a field only Sonare can fill would make every
   * future provider responsible for something it cannot compute. This is a
   * sibling for the same reason the timings are.
   *
   * Optional because a record written before it existed does not have one,
   * and because the route can legitimately skip it — see the comment there
   * on an indeterminate take.
   */
  alignment?: Alignment;
  /** Where the two verdicts differ, summarised so it is queryable. */
  verdicts?: VerdictComparison;
}

/**
 * `at` is a display-formatted ISO string, not a BSON Date — a Mongo TTL
 * index can only expire documents on an actual Date field, so this adds one
 * purely for that (db.ts's ensureIndexes()). Kept off the public
 * AttemptRecord type so nothing calling recordAttempt() needs to know it
 * exists.
 */
interface AttemptDocument extends AttemptRecord {
  createdAt: Date;
}

export async function recordAttempt(record: AttemptRecord): Promise<void> {
  try {
    const db = await getDb();
    const doc: AttemptDocument = { ...record, createdAt: new Date() };
    await db.collection<AttemptDocument>("attempts").insertOne(doc);
  } catch (err) {
    // Never fail a learner's scoring request because the log write failed.
    logger.error({ err }, "[attempts] failed to persist record");
    // But don't just drop it either — this record is the measurement the
    // product exists to produce (PRD.md §8). Fall back to a local file so a
    // transient Mongo outage doesn't silently erase it; replay it later with
    // `npm run replay-fallback`.
    /**
     * Guarded, even though appendFallback swallows its own failures. This
     * function's contract is that it never fails a learner's request, and
     * relying on another module to keep that promise makes it true by
     * coincidence rather than by construction — one bug over there and a
     * rejection escapes from here. Caught by a test that broke appendFallback
     * on purpose.
     *
     * try/catch rather than `.catch()`, for the same reason one step further
     * down: `.catch()` handles a rejected promise, and a *synchronous* throw
     * never gets that far — the promise it would attach to does not exist
     * yet. That the call cannot throw synchronously today is a fact about
     * appendFallback being declared `async`, which is exactly the kind of
     * dependence on another file this comment already objects to. Caught by a
     * test that made appendFallback throw synchronously on purpose.
     */
    try {
      await appendFallback("attempts", record);
    } catch {
      // Nothing left that can be done, and nothing worth failing the request
      // for. The record is lost; the learner keeps their score.
    }
  }
}

/** For the internal diagnostics screen — most recent attempts first. */
export async function listAttempts(limit: number): Promise<AttemptRecord[]> {
  const db = await getDb();
  return db.collection<AttemptRecord>("attempts").find({}).sort({ at: -1 }).limit(limit).toArray();
}

/**
 * One learner's most recent attempts.
 *
 * The question a support ticket actually asks. "It never hears me" names a
 * person, and the unfiltered read above can only answer "what is failing
 * across everyone" — the most recent 50 records, every learner, no way to
 * narrow. The trail to answer it was already being written; there was no
 * query that could reach it.
 *
 * Keyed on `learnerId` rather than `learnerName`, for the same reason the
 * deletion below is. The name is self-reported free text: two people who
 * both typed "Kimo" are one name and two learners, so filtering on it would
 * merge their trails and invite a confident wrong conclusion about whose
 * microphone is broken — reintroducing at the support desk exactly the
 * conflation identity.ts exists to prevent. The id is also the only field
 * here that anything else already queries by.
 *
 * `{ learnerId: 1, at: -1 }` in db.ts is this query's index, prefix and sort
 * both — so this is a bounded lookup rather than a scan filtered after the
 * fact.
 *
 * Only reaches records that carry a `learnerId`: an anonymous take belongs to
 * nobody findable, which is the honest cost of letting people practise
 * without registering, and is the same limit deletion runs into.
 *
 * Serves two callers that must not drift apart: this is also the read half of
 * `deleteAttemptsFor`, and the two halves of a data request have to agree
 * about what "mine" means or one of them is lying. Kept separate from
 * `listAttempts` above deliberately — that one is the unfiltered dashboard
 * view, and a learner-facing route must never be one forgotten filter away
 * from handing someone the whole collection.
 */
export async function listAttemptsFor(learnerId: string, limit: number): Promise<AttemptRecord[]> {
  const db = await getDb();
  return db
    .collection<AttemptRecord>("attempts")
    .find({ learnerId })
    .sort({ at: -1 })
    .limit(limit)
    .toArray();
}

/**
 * Erases one learner's attempt trail.
 *
 * Part of a deletion request. Only reaches records that carry a `learnerId` —
 * anonymous takes cannot be attributed to anyone and so cannot be found by
 * anyone either, which is the honest consequence of letting people practise
 * without registering. Those expire on the TTL.
 */
export async function deleteAttemptsFor(learnerId: string): Promise<number> {
  const db = await getDb();
  const result = await db.collection<AttemptRecord>("attempts").deleteMany({ learnerId });
  return result.deletedCount;
}
