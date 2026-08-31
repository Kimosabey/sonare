/**
 * FR-18 — an attempt record per scoring call, persisted to MongoDB.
 *
 * Audio itself is not persisted — nothing in the PRD asks for it, and storing
 * learner voice recordings is a data-protection decision, not a build one.
 */

import { getDb } from "./db.js";
import type { PronunciationResult } from "./services/types.js";

export interface AttemptRecord {
  at: string;
  /** Ties every attempt/diagnostic in one session together for funnel analysis. */
  sessionId?: string;
  activityId?: number;
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

export async function recordAttempt(record: AttemptRecord): Promise<void> {
  try {
    const db = await getDb();
    await db.collection<AttemptRecord>("attempts").insertOne(record);
  } catch (err) {
    // Never fail a learner's scoring request because the log write failed.
    console.error("[attempts] failed to persist record:", String(err));
  }
}

/** For the internal diagnostics screen — most recent attempts first. */
export async function listAttempts(limit: number): Promise<AttemptRecord[]> {
  const db = await getDb();
  return db.collection<AttemptRecord>("attempts").find({}).sort({ at: -1 }).limit(limit).toArray();
}
