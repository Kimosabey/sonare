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

/** Erases one learner's diagnostic reports. Part of a deletion request. */
export async function deleteDiagnosticsFor(learnerId: string): Promise<number> {
  const db = await getDb();
  const result = await db.collection("diagnostics").deleteMany({ learnerId });
  return result.deletedCount;
}

/**
 * One learner's own diagnostic reports, most recent first.
 *
 * The read half of `deleteDiagnosticsFor`. These carry device fingerprints and
 * failure detail, which is precisely why the learner-id field was added here
 * at all — a learner who can have them deleted should be able to see them,
 * and both halves need the same filter to mean the same thing.
 *
 * Separate from `listDiagnostics` above for the same reason the attempts
 * reader is: that one is the internal dashboard's unfiltered view.
 */
export async function listDiagnosticsFor(
  learnerId: string,
  limit: number,
): Promise<DiagnosticRecord[]> {
  const db = await getDb();
  return db
    .collection<DiagnosticRecord>("diagnostics")
    .find({ learnerId })
    .sort({ at: -1 })
    .limit(limit)
    .toArray();
}
