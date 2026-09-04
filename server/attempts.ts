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

export interface AttemptRecord {
  at: string;
  /** Ties every attempt/diagnostic in one session together for funnel analysis. */
  sessionId?: string;
  activityId?: number;
  /** Self-reported on the language picker — identifies a person, not just a session. */
  learnerName?: string;
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
