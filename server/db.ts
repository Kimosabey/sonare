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

/**
 * Index declarations, grouped by **retention class**.
 *
 * The two classes are the whole point of this file's second half.
 *
 * `telemetry` is written for us: spoken phrases, device context, session ids,
 * mic failures. It is privacy-sensitive and only useful for debugging a recent
 * session, so it expires on a schedule.
 *
 * `learnerRecord` is written for the learner: their identity, progress, sound
 * history and practice days. **It must never carry a TTL.** Expiring a
 * learner's own history on a timer is a bug rather than a policy — and the one
 * that would hurt most, because it is silent, delayed by months, and destroys
 * exactly the data the product exists to accumulate. The syllable accuracies
 * inside an expiring attempt are rolled into `skills` before it goes
 * (domain/rollup.ts) precisely so the split can be clean.
 *
 * `operational` is neither: counters, rate-limit windows and device link
 * codes, each expiring on its own `expiresAt` rather than on the shared
 * privacy window.
 *
 * Two of those three do name a learner, and the class is still right. A
 * learner-keyed rate-limit window carries their id in its `_id`, and a link
 * code carries it in a field — but neither is a record *of* anything the
 * learner did, both are dead within minutes, and both want a life measured in
 * minutes rather than the ninety days telemetry gets or the forever the
 * learner's own history gets. What they do inherit from naming a learner is
 * the obligation to be swept by a deletion request, which is why both appear
 * in `LEARNER_COLLECTIONS` in routes/learners.ts. A short life is not a
 * substitute for erasing on request; it is a bound on the damage of missing
 * one.
 *
 * `aggregate` is daily rollups — counts and means with **no learner content in
 * them at all**, kept indefinitely so a trend outlives the takes it came from.
 * "Was the indeterminate rate always this high" is a question about last
 * spring, and there is no answer once the evidence has been swept. Keeping
 * these forever is a different decision from keeping the attempts, which is
 * exactly why they are a different class and not just telemetry with a longer
 * window.
 *
 * Declared as data rather than as a list of calls so the classes are legible
 * and so a test can assert the invariant that matters: nothing in
 * learnerRecord has an expiry.
 */

// A NaN retention window is a TTL index of NaN seconds — learner voice
// metadata kept indefinitely, which is a privacy posture nobody chose.
const RETENTION_DAYS = numberFromEnv("RETENTION_DAYS", 90, { integer: true, max: 3650 });
const RETENTION_SECONDS = RETENTION_DAYS * 24 * 60 * 60;

export type RetentionClass = "telemetry" | "learnerRecord" | "operational" | "aggregate";

export interface IndexSpec {
  collection: string;
  keys: Record<string, 1 | -1>;
  /** Seconds until expiry, or 0 to expire at the time in the field. */
  expireAfterSeconds?: number;
  /** Why this index exists, for whoever reads a slow query later. */
  why: string;
}

/**
 * Every index, with its class.
 *
 * Exported so it can be asserted against rather than only executed. The
 * invariant a test pins is one line of policy: no `expireAfterSeconds`
 * anywhere in `learnerRecord`.
 */
export const INDEXES: Record<RetentionClass, IndexSpec[]> = {
  telemetry: [
    {
      collection: "attempts",
      keys: { at: -1 },
      why: "The diagnostics screen reads most-recent-first; without it, a collection scan.",
    },
    {
      collection: "attempts",
      keys: { sessionId: 1 },
      why: "Correlates every attempt and diagnostic in one session for funnel analysis.",
    },
    {
      collection: "attempts",
      keys: { learnerId: 1, at: -1 },
      why: "Makes \"show me my history\" a lookup rather than a full scan.",
    },
    {
      collection: "attempts",
      keys: { createdAt: 1 },
      expireAfterSeconds: RETENTION_SECONDS,
      why: "Bounds how long spoken phrases, device info and session ids are kept.",
    },
    {
      collection: "diagnostics",
      keys: { at: -1 },
      why: "Most-recent-first for the diagnostics screen, which is the only reader.",
    },
    {
      collection: "diagnostics",
      keys: { sessionId: 1 },
      why: "Ties a mic failure to the attempts around it, which is what makes it diagnosable.",
    },
    {
      collection: "diagnostics",
      keys: { createdAt: 1 },
      expireAfterSeconds: RETENTION_SECONDS,
      why: "Same privacy window as attempts.",
    },
  ],

  learnerRecord: [
    {
      collection: "learners",
      keys: { lastSeenAt: -1 },
      why: "Counting who is active. `_id` already serves the per-request read.",
    },
    {
      collection: "progress",
      keys: { learnerId: 1 },
      why: "The full sync pull and the deletion sweep, both of which ask by learner.",
    },
    {
      collection: "skills",
      keys: { learnerId: 1 },
      why: "The full sync pull and the deletion sweep, as with progress.",
    },
    {
      collection: "streaks",
      keys: { learnerId: 1 },
      why: "Only the deletion sweep — `_id` is the bare learner id, so reads need nothing.",
    },
  ],

  /**
   * Empty, and correctly so. `stats` is keyed on the day, and Mongo's own
   * `_id` index serves both a lookup and a descending sort — a `{ _id: -1 }`
   * index would be redundant at best and rejected as a duplicate at worst.
   *
   * The class still exists because it records the retention decision, which is
   * the part that matters: nothing here ever gets a TTL.
   */
  aggregate: [
    /**
     * content holds published activity sets — phrases and instructions, with
     * nothing about any learner in them. Never expires: an old version is how
     * a rollback works, and a TTL would delete the set a learner mid-session
     * is still being scored against.
     *
     * `{ slug: 1, version: -1 }` is the only query — the newest version of one
     * language — and without it that is a collection scan on every fetch.
     */
    {
      collection: "content",
      keys: { slug: 1, version: -1 },
      why: "Fetching the newest published version of one language, which is the only read.",
    },
  ],

  operational: [
    {
      collection: "counters",
      keys: { expiresAt: 1 },
      expireAfterSeconds: 0,
      why: "Each day's counter sets its own horizon; counts, not learner content.",
    },
    {
      collection: "ratelimits",
      keys: { expiresAt: 1 },
      expireAfterSeconds: 0,
      why: "A closed window is only garbage — a new window is a new document id.",
    },
    {
      collection: "linkcodes",
      keys: { expiresAt: 1 },
      expireAfterSeconds: 0,
      why: "A device link code is a credential with a ten-minute life; this sweep is what makes that life real rather than advisory.",
    },
  ],
};

/** Mongo's "an index with this name exists with different options". */
const INDEX_OPTIONS_CONFLICT = 85;

function isConflict(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === INDEX_OPTIONS_CONFLICT || code === "IndexOptionsConflict";
}

/**
 * Creates every index, one at a time.
 *
 * Sequentially and individually rather than through one `Promise.all` with a
 * single catch: that shape meant the first failure discarded the outcome of
 * every other index, so one conflicting TTL could quietly leave a dozen
 * missing indexes behind a single vague log line.
 *
 * `createIndex` is idempotent, so running this on every connect is safe.
 * A missing index costs query speed or unbounded retention, never
 * correctness — so this never fails startup or `getDb()`.
 */
export async function ensureIndexes(db: Db): Promise<void> {
  for (const [retention, specs] of Object.entries(INDEXES) as Array<[RetentionClass, IndexSpec[]]>) {
    for (const spec of specs) {
      /**
       * The invariant, enforced here and not only in a test.
       *
       * A TTL added to a learner collection would delete that learner's
       * history — months later, silently, with no error and nothing to
       * correlate it against. Refusing to create it is the cheap half; saying
       * so loudly is the half that gets it fixed.
       */
      if (retention === "learnerRecord" && spec.expireAfterSeconds !== undefined) {
        logger.error(
          { collection: spec.collection, keys: spec.keys },
          "[db] refusing a TTL on a learner-record collection — this would delete a learner's own history",
        );
        continue;
      }

      try {
        await db
          .collection(spec.collection)
          .createIndex(
            spec.keys,
            spec.expireAfterSeconds === undefined ? {} : { expireAfterSeconds: spec.expireAfterSeconds },
          );
      } catch (err) {
        if (isConflict(err)) {
          /**
           * Mongo rejects a `createIndex` that changes `expireAfterSeconds` on
           * an existing index rather than adjusting it, so changing
           * RETENTION_DAYS on a database that already has the index is a
           * manual operation. The old message said only "failed to ensure
           * indexes", which is true and useless — this one names the command.
           */
          const field = Object.keys(spec.keys)[0] ?? "createdAt";
          logger.error(
            {
              collection: spec.collection,
              keys: spec.keys,
              wanted: spec.expireAfterSeconds,
              fix: `db.${spec.collection}.dropIndex("${field}_1") then restart`,
            },
            "[db] a TTL index already exists with a different window — the retention change has NOT been applied",
          );
          continue;
        }
        logger.error({ err, collection: spec.collection, keys: spec.keys, why: spec.why }, "[db] failed to create an index");
      }
    }
  }
}
