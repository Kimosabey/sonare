/**
 * One shared Mongo connection, lazily established and cached so every route
 * reuses it instead of reconnecting per request.
 */

import { MongoClient } from "mongodb";
import type { Db } from "mongodb";
import { logger } from "./logger.js";

const MONGO_URL = process.env.MONGO_URL ?? "mongodb://localhost:27017";
const MONGO_DB_NAME = process.env.MONGO_DB ?? "sonare";

let dbPromise: Promise<Db> | null = null;

export function getDb(): Promise<Db> {
  if (!dbPromise) {
    const client = new MongoClient(MONGO_URL);
    dbPromise = client
      .connect()
      .then(async () => {
        logger.info({ db: MONGO_DB_NAME }, "[db] connected to MongoDB");
        const db = client.db(MONGO_DB_NAME);
        await ensureIndexes(db);
        return db;
      })
      .catch((err: unknown) => {
        // Clear the cache so the next call retries rather than replaying the
        // same rejected promise forever.
        dbPromise = null;
        throw err;
      });
  }
  return dbPromise;
}

const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? 90);
const RETENTION_SECONDS = RETENTION_DAYS * 24 * 60 * 60;

/**
 * attempts/diagnostics are both read most-recent-first ({at:-1}, exactly
 * Diagnostics.tsx's query shape) and are explicitly designed to correlate by
 * sessionId for funnel analysis (see attempts.ts's own comment) — without
 * these, both are full collection scans. createIndex is idempotent, so
 * running this on every connect (not just the very first) is safe.
 *
 * The TTL indexes on `createdAt` (attempts.ts/diagnostics.ts's own Date
 * field, since Mongo can only expire on a real Date, not `at`'s ISO string)
 * bound how long spoken phrases, device info and session IDs sit in the
 * database. Changing RETENTION_DAYS after the index already exists requires
 * dropping and recreating it by hand — Mongo rejects createIndex() with a
 * conflicting expireAfterSeconds on an existing index rather than adjusting
 * it, which is exactly the kind of thing this function's catch below is for.
 */
async function ensureIndexes(db: Db): Promise<void> {
  try {
    await Promise.all([
      db.collection("attempts").createIndex({ at: -1 }),
      db.collection("attempts").createIndex({ sessionId: 1 }),
      db.collection("attempts").createIndex({ createdAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS }),
      db.collection("diagnostics").createIndex({ at: -1 }),
      db.collection("diagnostics").createIndex({ sessionId: 1 }),
      db.collection("diagnostics").createIndex({ createdAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS }),
    ]);
  } catch (err) {
    // A missing index costs query speed (or unbounded retention), not
    // correctness — never fail startup, or getDb() itself, over this.
    logger.error({ err }, "[db] failed to ensure indexes");
  }
}
