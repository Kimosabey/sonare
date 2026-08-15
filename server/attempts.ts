/**
 * FR-18 — an attempt record per scoring call.
 *
 * JSONL on disk. The POC's deliverable is an analysable record of 80 fixture
 * runs (PRD §8), not a production data store; a line-per-attempt file is
 * trivially greppable, appendable without locking, and needs no dependency.
 *
 * Audio itself is not persisted — nothing in the PRD asks for it, and storing
 * learner voice recordings is a data-protection decision, not a build one.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PronunciationResult } from "./services/types.js";

const ATTEMPTS_PATH = join(process.cwd(), "server", "data", "attempts.jsonl");

export interface AttemptRecord {
  at: string;
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
    await mkdir(dirname(ATTEMPTS_PATH), { recursive: true });
    await appendFile(ATTEMPTS_PATH, JSON.stringify(record) + "\n", "utf8");
  } catch (err) {
    // Never fail a learner's scoring request because the log write failed.
    console.error("[attempts] failed to persist record:", String(err));
  }
}
