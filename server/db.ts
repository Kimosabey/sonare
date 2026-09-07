/**
 * One shared Mongo connection, lazily established and cached so every route
 * reuses it instead of reconnecting per request.
 */

import { MongoClient } from "mongodb";
import type { Db } from "mongodb";
import { logger } from "./logger.js";
import { numberFromEnv } from "./env.js";

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

// A NaN retention window is a TTL index of NaN seconds — learner voice
// metadata kept indefinitely, which is a privacy posture nobody chose.
const RETENTION_DAYS = numberFromEnv("RETENTION_DAYS", 90, { integer: true, max: 3650 });
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
      /**
       * counters expires on its own `expiresAt` rather than the shared
       * RETENTION_DAYS window, because it is a different class of data: counts
       * with no learner content in them, kept only long enough to answer a
       * billing question. `expireAfterSeconds: 0` means "expire at the time in
       * the field", which is what lets counters.ts set its own horizon per
       * document instead of inheriting the privacy retention window.
       */
      db.collection("counters").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      /**
       * ratelimits is swept, never read after its window closes — a new window
       * is a new document id (rateLimitStore.ts), so an expired one is only
       * ever garbage. Without this the collection grows by one document per
       * client per minute, forever.
       */
      db.collection("ratelimits").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      /**
       * learners is keyed on the client-minted id, so `_id` already serves the
       * only lookup that happens per request. lastSeenAt is for counting who
       * is active, which is a scan otherwise.
       *
       * No TTL here, deliberately: this is the learner's own record, and
       * expiring it on a timer would orphan their progress. That split —
       * telemetry expires, the learner's record does not — is the point of
       * keeping them in different collections.
       */
      db.collection("learners").createIndex({ lastSeenAt: -1 }),
      /**
       * The index that makes "show me my history" a lookup rather than a full
       * collection scan. Nothing asked that question before learners had ids.
       */
      db.collection("attempts").createIndex({ learnerId: 1, at: -1 }),
      /**
       * progress is keyed `{learnerId}:{slug}`, so `_id` serves the per-request
       * read. This one serves the full sync pull and the deletion sweep, both
       * of which ask for every language a learner has touched.
       *
       * No TTL: the learner's own record.
       */
      db.collection("progress").createIndex({ learnerId: 1 }),
    ]);
  } catch (err) {
    // A missing index costs query speed (or unbounded retention), not
    // correctness — never fail startup, or getDb() itself, over this.
    logger.error({ err }, "[db] failed to ensure indexes");
  }
}
