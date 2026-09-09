/**
 * Client- and server-side capture/scoring errors, persisted for analysis —
 * these previously only ever surfaced as a local toast and were never seen
 * again. Same non-blocking philosophy as attempts.ts: never throw, just log
 * and move on.
 */

import { getDb } from "./db.js";
import { appendFallback } from "./fallbackLog.js";
import { logger } from "./logger.js";

export interface DiagnosticRecord {
  at: string;
  source: "client" | "server";
  /** Ties every attempt/diagnostic in one session together for funnel analysis. */
  sessionId?: string;
  activityId?: number;
  /** Self-reported on the language picker — identifies a person, not just a session. */
  learnerName?: string;
  /**
   * The signed learner id, when the report carried a valid token.
   *
   * Added so a deletion request can actually reach these records. Without it
   * "delete my data" would leave a trail of device fingerprints and failure
   * details behind, expiring only on the 90-day TTL — which is a promise
   * quietly not kept rather than a limitation anyone chose.
   */
  learnerId?: string;
  code: string;
  domain: string;
  message: string;
  userMessage?: string;
  context?: unknown;
}

/** See attempts.ts's AttemptDocument — same reasoning, same TTL purpose. */
interface DiagnosticDocument extends DiagnosticRecord {
  createdAt: Date;
}

export async function recordDiagnostic(record: DiagnosticRecord): Promise<void> {
  try {
    const db = await getDb();
    const doc: DiagnosticDocument = { ...record, createdAt: new Date() };
    await db.collection<DiagnosticDocument>("diagnostics").insertOne(doc);
  } catch (err) {
    logger.error({ err }, "[diagnostics] failed to persist record");
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
      await appendFallback("diagnostics", record);
    } catch {
      // Nothing left that can be done, and nothing worth failing the request
      // for. The record is lost; the learner keeps their score.
    }
  }
}

/** For the internal diagnostics screen — most recent errors first. */
export async function listDiagnostics(limit: number): Promise<DiagnosticRecord[]> {
  const db = await getDb();
  return db.collection<DiagnosticRecord>("diagnostics").find({}).sort({ at: -1 }).limit(limit).toArray();
}

/**
 * One learner's most recent diagnostic reports.
 *
 * The other half of a per-learner lookup, and not optional: a capture failure
 * that never reached scoring exists only here, while an indeterminate take
 * exists only in attempts. A responder reading either list alone sees half
 * the timeline — and half a timeline is what makes a wrong conclusion look
 * well-evidenced.
 *
 * Keyed on `learnerId` for the reasons listAttemptsFor() gives, and reaching
 * only records that carry one.
 *
 * Index note, and the one asymmetry worth knowing: `attempts` has
 * `{ learnerId: 1, at: -1 }` in db.ts and this collection has nothing on
 * `learnerId` — only `{ at: -1 }`, `{ sessionId: 1 }` and the TTL. So Mongo
 * walks `{ at: -1 }` newest-first and filters as it goes, which `limit`
 * bounds. Fine at this collection's size under a 90-day TTL, and a matching
 * `{ learnerId: 1, at: -1 }` here is the index it really wants if that stops
 * being true — a db.ts decision, deliberately not made from this file.
 *
 * Serves two callers. It is also the read half of `deleteDiagnosticsFor`:
 * these records carry device fingerprints and failure detail, which is why
 * the learner-id field is here at all, and a learner who can have them
 * deleted should be able to see them. Both halves need the same filter to
 * mean the same thing.
 */
export async function listDiagnosticsFor(learnerId: string, limit: number): Promise<DiagnosticRecord[]> {
  const db = await getDb();
  return db
    .collection<DiagnosticRecord>("diagnostics")
    .find({ learnerId })
    .sort({ at: -1 })
    .limit(limit)
    .toArray();
}

/** Erases one learner's diagnostic reports. Part of a deletion request. */
export async function deleteDiagnosticsFor(learnerId: string): Promise<number> {
  const db = await getDb();
  const result = await db.collection("diagnostics").deleteMany({ learnerId });
  return result.deletedCount;
}
