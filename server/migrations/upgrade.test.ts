/**
 * The runner against a database shaped like the previous version.
 *
 * index.test.ts covers the runner's bookkeeping — what it records, what it
 * skips, how the lock behaves — and covers it well. But its fake `Db` returns
 * the same collection whatever name it is asked for, and implements only the
 * four operations the runner itself calls. So a migration's `up` has nowhere
 * to write: every migration in that file is a function that notes it ran. The
 * one thing a migration system exists to do has therefore never been executed.
 *
 * This file gives migrations a database with named collections and the
 * operations a real one would reach for, seeds it with shapes this schema
 * genuinely used to have, and asserts the shape afterwards. Three questions,
 * none of which the structural tests can ask:
 *
 *   Does a migration actually transform the data?
 *   Is it safe to run twice, as the runner's contract requires?
 *   When one fails, is the database left in a state a later run can finish?
 *
 * The fake is strict in the same way the end-to-end one is: it implements the
 * filter and update operators the migrations here use, and throws on anything
 * else. A permissive fake is worse than none — an `$unset` that silently did
 * nothing would let a migration "pass" while leaving the old field in place,
 * and the assertion after it would be checking the seed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "mongodb";
import { appliedIds, pending, run, validate, type Migration } from "./index.js";
import { MIGRATIONS } from "./list.js";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/* ── a database with more than one collection in it ─────────────────────── */

interface Doc {
  _id: string;
  [key: string]: unknown;
}

/** collection name → documents by id. */
let data: Map<string, Map<string, Doc>>;

function collectionOf(name: string): Map<string, Doc> {
  const existing = data.get(name);
  if (existing !== undefined) return existing;
  const created = new Map<string, Doc>();
  data.set(name, created);
  return created;
}

/**
 * Whether a document satisfies a filter.
 *
 * Every condition must hold, and an operator this does not implement throws.
 * Silently ignoring one would turn a selective query into a full scan, which
 * is how a migration ends up rewriting documents it was told to leave alone.
 */
function matches(doc: Doc, filter: Record<string, unknown>): boolean {
  for (const [field, condition] of Object.entries(filter)) {
    const value = doc[field];

    if (typeof condition === "object" && condition !== null && !(condition instanceof Date)) {
      const ops = condition as { $exists?: unknown; $regex?: unknown; $lt?: unknown; $ne?: unknown };

      if (typeof ops.$exists === "boolean") {
        if ((value !== undefined) !== ops.$exists) return false;
        continue;
      }
      if (typeof ops.$regex === "string") {
        if (typeof value !== "string" || !new RegExp(ops.$regex).test(value)) return false;
        continue;
      }
      if (ops.$lt instanceof Date) {
        if (!(value instanceof Date) || value >= ops.$lt) return false;
        continue;
      }
      if ("$ne" in ops) {
        if (value === ops.$ne) return false;
        continue;
      }
      throw new Error(`migration fake: filter on ${field} uses an operator it does not implement`);
    }

    if (value !== condition) return false;
  }
  return true;
}

/** Applies an update document, rejecting an operator it does not implement. */
function applyUpdate(doc: Doc, update: Record<string, unknown>, inserting: boolean): Doc {
  const next: Doc = { ...doc };

  for (const [operator, fields] of Object.entries(update)) {
    const entries = Object.entries(fields as Record<string, unknown>);
    switch (operator) {
      case "$set":
        for (const [field, value] of entries) next[field] = value;
        break;
      case "$unset":
        for (const [field] of entries) delete next[field];
        break;
      case "$inc":
        for (const [field, by] of entries) next[field] = ((next[field] as number) ?? 0) + (by as number);
        break;
      case "$setOnInsert":
        // Only on insert. A fake that applied this every time once made four
        // assertions in this project pass for the wrong reason.
        if (inserting) for (const [field, value] of entries) next[field] = value;
        break;
      default:
        throw new Error(`migration fake: update uses ${operator}, which it does not implement`);
    }
  }

  return next;
}

function fakeDb(): Db {
  return {
    collection: (name: string) => {
      const documents = (): Map<string, Doc> => collectionOf(name);

      const select = (filter: Record<string, unknown>): Doc[] =>
        [...documents().values()].filter((doc) => matches(doc, filter)).map((doc) => structuredClone(doc));

      return {
        find: (filter: Record<string, unknown> = {}) => ({
          toArray: () => Promise.resolve(select(filter)),
          sort: () => ({ limit: () => ({ toArray: () => Promise.resolve(select(filter)) }) }),
        }),
        findOne: (filter: Record<string, unknown> = {}) => Promise.resolve(select(filter)[0] ?? null),
        countDocuments: (filter: Record<string, unknown> = {}) => Promise.resolve(select(filter).length),
        insertOne: (doc: Doc) => {
          if (documents().has(doc._id)) {
            const err = new Error("E11000 duplicate key") as Error & { code: number };
            err.code = 11000;
            return Promise.reject(err);
          }
          documents().set(doc._id, structuredClone(doc));
          return Promise.resolve({ acknowledged: true, insertedId: doc._id });
        },
        updateOne: (
          filter: Record<string, unknown> & { _id?: string },
          update: Record<string, unknown>,
          options?: { upsert?: boolean },
        ) => {
          const hit = select(filter)[0];
          if (hit === undefined) {
            if (options?.upsert !== true || typeof filter._id !== "string") {
              return Promise.resolve({ matchedCount: 0, modifiedCount: 0, acknowledged: true });
            }
            documents().set(filter._id, applyUpdate({ _id: filter._id }, update, true));
            return Promise.resolve({ matchedCount: 0, modifiedCount: 0, upsertedCount: 1, acknowledged: true });
          }
          documents().set(hit._id, applyUpdate(hit, update, false));
          return Promise.resolve({ matchedCount: 1, modifiedCount: 1, acknowledged: true });
        },
        updateMany: (filter: Record<string, unknown>, update: Record<string, unknown>) => {
          const hits = select(filter);
          for (const hit of hits) documents().set(hit._id, applyUpdate(hit, update, false));
          return Promise.resolve({ matchedCount: hits.length, modifiedCount: hits.length, acknowledged: true });
        },
        deleteOne: (filter: Record<string, unknown>) => {
          const hit = select(filter)[0];
          if (hit === undefined) return Promise.resolve({ deletedCount: 0, acknowledged: true });
          documents().delete(hit._id);
          return Promise.resolve({ deletedCount: 1, acknowledged: true });
        },
        deleteMany: (filter: Record<string, unknown>) => {
          const hits = select(filter);
          for (const hit of hits) documents().delete(hit._id);
          return Promise.resolve({ deletedCount: hits.length, acknowledged: true });
        },
        createIndex: () => Promise.resolve("ok"),
      };
    },
  } as unknown as Db;
}

/* ── the shapes this schema used to have ────────────────────────────────── */

const LEARNER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER = "11111111-2222-4333-8444-555555555555";

/**
 * Every collection here is keyed on a string the client or the store minted,
 * never on an ObjectId. Named so the migrations below say so at the call site
 * — an untyped `db.collection(name)` defaults to an ObjectId key, and a real
 * migration written that way would not compile against this schema either.
 */
interface StringIdDocument {
  _id: string;
  [key: string]: unknown;
}

/**
 * A database as a build before the current one left it.
 *
 * Both shapes are real. `progress` and `skills` documents carry the learner id
 * in the key and had no `learnerId` field, which is what made them invisible
 * to a pull and to a deletion request. `streaks` held a `count`, which
 * domain/merge.ts records as the thing that cannot be merged — only clobbered
 * — and which is why days are stored as dates now.
 */
function seedOldShape(): void {
  collectionOf("progress").set(`${LEARNER}:fr`, {
    _id: `${LEARNER}:fr`,
    slug: "fr",
    entries: [{ activityId: 1, passed: true, bestAccuracy: 88, attemptsUsed: 2, skipped: false, at: "2026-09-01T10:00:00.000Z" }],
    version: 3,
  });
  collectionOf("progress").set(`${OTHER}:hi`, { _id: `${OTHER}:hi`, slug: "hi", entries: [], version: 1 });
  collectionOf("skills").set(`${LEARNER}:fr`, {
    _id: `${LEARNER}:fr`,
    slug: "fr",
    skills: [{ grapheme: "ment", samples: [{ at: "2026-09-01T10:00:00.000Z", accuracy: 61 }] }],
    version: 2,
  });
  collectionOf("streaks").set(LEARNER, { _id: LEARNER, learnerId: LEARNER, count: 5, version: 4 });
  collectionOf("streaks").set(OTHER, { _id: OTHER, learnerId: OTHER, count: 0, version: 1 });
}

/**
 * Backfills `learnerId` from the document key.
 *
 * Written the way the runner's contract demands: it selects only the documents
 * that still need it, so running it against a database where it has already
 * run is a no-op rather than a rewrite of every row.
 */
const attributeSynced: Migration = {
  id: "0001-attribute-synced-documents",
  description: "sets learnerId from the document key on progress and skills",
  up: async (db) => {
    for (const name of ["progress", "skills"]) {
      const orphans = await db.collection<StringIdDocument>(name).find({ learnerId: { $exists: false } }).toArray();
      for (const doc of orphans) {
        const id = String(doc._id);
        await db.collection<StringIdDocument>(name).updateOne({ _id: id }, { $set: { learnerId: id.split(":")[0] } });
      }
    }
  },
};

/** Turns a streak count into the day list the merge rules need. */
const streakDays: Migration = {
  id: "0002-streak-days-from-count",
  description: "replaces the streak count with a day list and a longest run",
  up: async (db) => {
    const counted = await db.collection<StringIdDocument>("streaks").find({ count: { $exists: true } }).toArray();
    for (const doc of counted) {
      await db
        .collection<StringIdDocument>("streaks")
        .updateOne(
          { _id: String(doc._id) },
          { $set: { days: [], longest: doc["count"] as number }, $unset: { count: "" } },
        );
    }
  },
};

/** Writes something recognisable, so "did it run" is a question about data. */
function marker(id: string): Migration {
  return {
    id,
    description: `writes the marker for ${id}`,
    up: async (db) => {
      await db.collection<StringIdDocument>("markers").insertOne({ _id: id });
    },
  };
}

function failing(id: string, message = "the column was not there"): Migration {
  return {
    id,
    description: `fails on purpose, for ${id}`,
    up: () => Promise.reject(new Error(message)),
  };
}

function lockHeld(): boolean {
  return collectionOf("migrations").has("migrations:lock");
}

function markers(): string[] {
  return [...collectionOf("markers").keys()].sort();
}

beforeEach(() => {
  data = new Map();
  vi.clearAllMocks();
});

/* ── migrating a database that has the previous shape ───────────────────── */

describe("migrating an old-shape database", () => {
  it("produces the new shape", async () => {
    seedOldShape();

    const result = await run(fakeDb(), [attributeSynced, streakDays]);

    expect(result.ids).toEqual(["0001-attribute-synced-documents", "0002-streak-days-from-count"]);
    expect(result.failed).toBeUndefined();

    // Attribution: the field every pull and every deletion filters on.
    expect(collectionOf("progress").get(`${LEARNER}:fr`)?.["learnerId"]).toBe(LEARNER);
    expect(collectionOf("progress").get(`${OTHER}:hi`)?.["learnerId"]).toBe(OTHER);
    expect(collectionOf("skills").get(`${LEARNER}:fr`)?.["learnerId"]).toBe(LEARNER);

    // Streaks: days and a record, and the old field actually gone rather than
    // shadowed by the new one.
    expect(collectionOf("streaks").get(LEARNER)).toMatchObject({ days: [], longest: 5 });
    expect(collectionOf("streaks").get(LEARNER)).not.toHaveProperty("count");
    expect(collectionOf("streaks").get(OTHER)).toMatchObject({ days: [], longest: 0 });
  });

  it("leaves everything else in the document alone", async () => {
    // A migration that rewrote a document rather than amending it would pass
    // every assertion above while discarding the learner's practice.
    seedOldShape();
    const before = structuredClone(collectionOf("progress").get(`${LEARNER}:fr`));

    await run(fakeDb(), [attributeSynced, streakDays]);

    const after = collectionOf("progress").get(`${LEARNER}:fr`);
    expect(after?.["entries"]).toEqual(before?.["entries"]);
    expect(after?.["slug"]).toBe("fr");
    expect(after?.["version"]).toBe(3);
  });

  it("records each migration with what it was for", async () => {
    seedOldShape();
    const db = fakeDb();

    await run(db, [attributeSynced, streakDays]);

    expect([...(await appliedIds(db))].sort()).toEqual([
      "0001-attribute-synced-documents",
      "0002-streak-days-from-count",
    ]);
    expect(collectionOf("migrations").get("0001-attribute-synced-documents")).toMatchObject({
      description: attributeSynced.description,
    });
  });

  it("releases the lock, so the next deployment is not wedged", async () => {
    seedOldShape();

    await run(fakeDb(), [attributeSynced, streakDays]);

    expect(lockHeld()).toBe(false);
  });

  it("is a no-op the second time, and changes nothing", async () => {
    /**
     * Two properties at once, and they are different. The runner will not
     * *choose* to re-run a recorded migration — but each `up` also has to be
     * safe if it does, because a process killed between the write and the
     * record will run it again. So the state is compared after a second full
     * run, and again after `up` is invoked directly on the migrated database.
     */
    seedOldShape();
    const db = fakeDb();
    await run(db, [attributeSynced, streakDays]);
    const migrated = JSON.stringify([...data.get("progress")!, ...data.get("streaks")!]);

    const second = await run(db, [attributeSynced, streakDays]);

    expect(second.ids).toEqual([]);
    expect(JSON.stringify([...data.get("progress")!, ...data.get("streaks")!])).toBe(migrated);

    // And directly, as a crash-and-retry would.
    await attributeSynced.up(db);
    await streakDays.up(db);

    expect(JSON.stringify([...data.get("progress")!, ...data.get("streaks")!])).toBe(migrated);
  });

  it("applies only what is new when a migration is appended later", async () => {
    seedOldShape();
    const db = fakeDb();
    await run(db, [attributeSynced]);

    const second = await run(db, [attributeSynced, streakDays]);

    expect(second.ids).toEqual(["0002-streak-days-from-count"]);
    expect(collectionOf("streaks").get(LEARNER)).toMatchObject({ longest: 5 });
  });

  it("does nothing at all under a dry run", async () => {
    seedOldShape();
    const db = fakeDb();

    const result = await run(db, [attributeSynced, streakDays], { dryRun: true });

    expect(result.ids).toEqual(["0001-attribute-synced-documents", "0002-streak-days-from-count"]);
    // Reported, not applied: the old shape is untouched and nothing is
    // recorded, so a dry run cannot make the next real run skip work.
    expect(collectionOf("progress").get(`${LEARNER}:fr`)?.["learnerId"]).toBeUndefined();
    expect(collectionOf("streaks").get(LEARNER)?.["count"]).toBe(5);
    expect([...(await appliedIds(db))]).toEqual([]);
    expect(lockHeld()).toBe(false);
  });
});

/* ── a migration that fails part-way through a run ──────────────────────── */

describe("stopping at a failure, against real data", () => {
  it("does not touch the database past the one that failed", async () => {
    /**
     * The whole reason the runner is sequential and stops. Carrying on would
     * apply a later change on top of a schema the failed one was supposed to
     * have produced, which turns a clear failure into a corrupt database.
     *
     * Asserted on the data rather than on the returned id list, which is the
     * difference between this and the structural test: `0003` not being
     * *recorded* is not the same statement as `0003` not having *run*.
     */
    const db = fakeDb();
    seedOldShape();

    const result = await run(db, [attributeSynced, failing("0002-explodes"), marker("0003-after-the-failure")]);

    expect(result.failed).toEqual({ id: "0002-explodes", message: "the column was not there" });
    expect(result.ids).toEqual(["0001-attribute-synced-documents"]);
    // The one before it really did run.
    expect(collectionOf("progress").get(`${LEARNER}:fr`)?.["learnerId"]).toBe(LEARNER);
    // The one after it really did not.
    expect(markers()).toEqual([]);
    expect([...(await appliedIds(db))]).toEqual(["0001-attribute-synced-documents"]);
  });

  it("releases the lock, so the failure does not wedge every later run", async () => {
    /**
     * The failure mode this is really about: a lock held on the way out turns
     * one broken migration into a deployment that can never proceed, and the
     * fix would have to be somebody deleting a document by hand at the worst
     * possible moment.
     */
    const db = fakeDb();
    seedOldShape();

    const result = await run(db, [attributeSynced, failing("0002-explodes")]);

    expect(result.failed?.id).toBe("0002-explodes");
    expect(lockHeld()).toBe(false);
  });

  it("resumes from the failure once it is fixed, without redoing the rest", async () => {
    /**
     * The reason each migration is recorded the moment it succeeds rather than
     * at the end of the run. This is the whole recovery story, end to end: a
     * failed deployment, a fix, a second run that finishes the job.
     */
    const db = fakeDb();
    seedOldShape();
    await run(db, [attributeSynced, failing("0002-streak-days-from-count")]);

    // Same id, now working — which is what deploying the fix looks like.
    const second = await run(db, [attributeSynced, streakDays, marker("0003-after-the-failure")]);

    expect(second.failed).toBeUndefined();
    expect(second.ids).toEqual(["0002-streak-days-from-count", "0003-after-the-failure"]);
    expect(collectionOf("streaks").get(LEARNER)).toMatchObject({ days: [], longest: 5 });
    expect(markers()).toEqual(["0003-after-the-failure"]);
  });

  it("keeps the half-finished work of the migration that failed", async () => {
    /**
     * Forward-only means exactly this, and it is worth stating rather than
     * discovering: there is no rollback, so a migration that fails half way
     * leaves half its work behind. That is why `up` has to be written to be
     * resumable — the recovery is to run it again, not to undo it.
     */
    const db = fakeDb();
    seedOldShape();
    const halfWay: Migration = {
      id: "0002-half-way",
      description: "attributes one document and then fails",
      up: async (inner) => {
        await inner
          .collection<StringIdDocument>("progress")
          .updateOne({ _id: `${LEARNER}:fr` }, { $set: { learnerId: LEARNER } });
        throw new Error("connection reset");
      },
    };

    const result = await run(db, [halfWay, marker("0003-after-the-failure")]);

    expect(result.failed?.id).toBe("0002-half-way");
    // Its partial write stands. Nothing pretended to reverse it.
    expect(collectionOf("progress").get(`${LEARNER}:fr`)?.["learnerId"]).toBe(LEARNER);
    // And it is not recorded, so the next run will finish it.
    expect([...(await appliedIds(db))]).toEqual([]);
    expect(await pending(db, [halfWay])).toHaveLength(1);
    expect(lockHeld()).toBe(false);
  });

  it("refuses an invalid list without taking the lock or touching the data", async () => {
    // A bad list must not block a deployment while it is being fixed, and it
    // must not have applied the valid half of itself either.
    const db = fakeDb();
    seedOldShape();

    await expect(run(db, [streakDays, attributeSynced])).rejects.toThrow(/sorted order/);

    expect(collectionOf("streaks").get(LEARNER)?.["count"]).toBe(5);
    expect(lockHeld()).toBe(false);
  });

  it("does not run anything while another process holds the lock", async () => {
    // A fresh lock, so it is not reclaimed as abandoned.
    const db = fakeDb();
    seedOldShape();
    collectionOf("migrations").set("migrations:lock", {
      _id: "migrations:lock",
      heldSince: new Date(),
      by: "the-other-instance",
    });

    const result = await run(db, [attributeSynced, streakDays]);

    expect(result.skippedLocked).toBe(true);
    expect(collectionOf("progress").get(`${LEARNER}:fr`)?.["learnerId"]).toBeUndefined();
    // And it did not steal the lock on its way out.
    expect(collectionOf("migrations").get("migrations:lock")?.["by"]).toBe("the-other-instance");
  });
});

/* ── the fake refuses to flatter a migration ────────────────────────────── */

describe("the stand-in database", () => {
  /**
   * The fake's own guard rails, pinned so they stay guard rails.
   *
   * A migration written against an operator this does not implement would
   * otherwise appear to succeed while changing nothing, and the assertion
   * after it would be reading the seed back. That is the failure mode worth
   * spending two tests on: it does not look like a broken test, it looks like
   * a passing one.
   */
  it("refuses an update operator it does not implement", async () => {
    const db = fakeDb();
    seedOldShape();
    const renaming: Migration = {
      id: "0001-uses-rename",
      description: "renames a field with an operator the fake lacks",
      up: async (inner) => {
        await inner
          .collection<StringIdDocument>("streaks")
          .updateOne({ _id: LEARNER }, { $rename: { count: "longest" } });
      },
    };

    const result = await run(db, [renaming]);

    // Reported as a failed migration rather than a quiet success.
    expect(result.failed?.id).toBe("0001-uses-rename");
    expect(result.failed?.message).toMatch(/\$rename, which it does not implement/);
    expect(collectionOf("streaks").get(LEARNER)?.["count"]).toBe(5);
  });

  it("refuses a filter operator it does not implement", async () => {
    const db = fakeDb();
    seedOldShape();
    const selecting: Migration = {
      id: "0001-uses-in",
      description: "selects with an operator the fake lacks",
      up: async (inner) => {
        await inner
          .collection<StringIdDocument>("streaks")
          .find({ count: { $in: [0, 5] } })
          .toArray();
      },
    };

    const result = await run(db, [selecting]);

    expect(result.failed?.message).toMatch(/filter on count uses an operator it does not implement/);
  });
});

/* ── the list this repo actually ships ──────────────────────────────────── */

describe("the shipped migration list", () => {
  it("is valid", () => {
    expect(validate(MIGRATIONS)).toEqual([]);
  });

  it("runs against an old-shape database and is idempotent", async () => {
    /**
     * Empty today, which makes this a no-op — and that is the point. The
     * moment somebody appends a real migration, this starts exercising it
     * against a seeded database and running it twice, with nothing to add
     * here. A test that named the migrations it knew about would go stale on
     * the first one written after it.
     */
    const db = fakeDb();
    seedOldShape();

    const first = await run(db, MIGRATIONS);
    const afterFirst = JSON.stringify([...data].map(([name, docs]) => [name, [...docs]]));
    const second = await run(db, MIGRATIONS);

    expect(first.failed).toBeUndefined();
    expect(second.ids).toEqual([]);
    expect(JSON.stringify([...data].map(([name, docs]) => [name, [...docs]]))).toBe(afterFirst);
    expect(lockHeld()).toBe(false);
  });
});
