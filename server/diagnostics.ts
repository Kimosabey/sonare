/**
 * Client- and server-side capture/scoring errors, persisted for analysis —
 * these previously only ever surfaced as a local toast and were never seen
 * again. Same non-blocking philosophy as attempts.ts: never throw, just log
 * and move on.
 */

import { getDb } from "./db.js";
import { appendFallback } from "./fallbackLog.js";

export interface DiagnosticRecord {
  at: string;
  source: "client" | "server";
  /** Ties every attempt/diagnostic in one session together for funnel analysis. */
  sessionId?: string;
  activityId?: number;
  /** Self-reported on the language picker — identifies a person, not just a session. */
  learnerName?: string;
  code: string;
  domain: string;
  message: string;
  userMessage?: string;
  context?: unknown;
}

export async function recordDiagnostic(record: DiagnosticRecord): Promise<void> {
  try {
    const db = await getDb();
    await db.collection<DiagnosticRecord>("diagnostics").insertOne(record);
  } catch (err) {
    console.error("[diagnostics] failed to persist record:", String(err));
    await appendFallback("diagnostics", record);
  }
}

/** For the internal diagnostics screen — most recent errors first. */
export async function listDiagnostics(limit: number): Promise<DiagnosticRecord[]> {
  const db = await getDb();
  return db.collection<DiagnosticRecord>("diagnostics").find({}).sort({ at: -1 }).limit(limit).toArray();
}
