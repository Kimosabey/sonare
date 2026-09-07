/**
 * Retention, split by purpose — asserted as policy rather than trusted to a
 * comment.
 *
 * Two classes of data live in this database. Telemetry is written for us:
 * spoken phrases, device context, session ids, mic failures. It is
 * privacy-sensitive, only useful for debugging a recent session, and it
 * expires on a schedule.
 *
 * The learner's record is written for the learner: identity, progress, sound
 * history, practice days. A TTL on any of it would delete their own history —
 * silently, months later, with no error and nothing to correlate against. That
 * is the single worst thing this database could do, so it is checked
 * structurally: the declarations are data, and this reads them.
 */

import { describe, expect, it, vi } from "vitest";
import { INDEXES, ensureIndexes, type IndexSpec } from "./db.js";
import type { Db } from "mongodb";

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** Records what was asked for, and can be told to fail a given collection. */
function fakeDb(fail?: { collection: string; error: Error }): {
  db: Db;
  created: Array<{ collection: string; keys: unknown; options: unknown }>;
} {
  const created: Array<{ collection: string; keys: unknown; options: unknown }> = [];
  const db = {
    collection: (name: string) => ({
      createIndex: (keys: unknown, options: unknown) => {
        if (fail !== undefined && fail.collection === name) return Promise.reject(fail.error);
        created.push({ collection: name, keys, options });
        return Promise.resolve("ok");
      },
    }),
  } as unknown as Db;
  return { db, created };
}

function conflict(): Error & { code: number } {
  const err = new Error("Index already exists with different options") as Error & { code: number };
  err.code = 85;
  return err;
}

const all: IndexSpec[] = Object.values(INDEXES).flat();

describe("the learner's own record never expires", () => {
  it("declares no TTL on any learner collection", () => {
    /**
     * The invariant. Expiring a learner's history on a timer is a bug rather
     * than a policy, and it is the one that would hurt most: silent, delayed
     * by months, and destroying exactly the data the product exists to
     * accumulate.
     */
    for (const spec of INDEXES.learnerRecord) {
      expect(spec.expireAfterSeconds, `${spec.collection} must not expire`).toBeUndefined();
    }
  });

  it("never expires a daily rollup either", () => {
    /**
     * The whole reason the aggregate class exists. `attempts` expires after
     * ninety days, and "was the indeterminate rate always this high" is a
     * question about last spring — there is no answer to it once the evidence
     * has been swept. The rollups hold counts and means with no learner
     * content, so keeping them indefinitely is a different decision from
     * keeping the takes.
     */
    for (const spec of INDEXES.aggregate) {
      expect(spec.expireAfterSeconds, `${spec.collection} must not expire`).toBeUndefined();
    }
  });

  it("covers every collection that holds a learner's record", () => {
    // So the invariant above cannot be satisfied by forgetting a collection.
    const collections = new Set(INDEXES.learnerRecord.map((s) => s.collection));

    expect(collections).toEqual(new Set(["learners", "progress", "skills", "streaks"]));
  });

  it("refuses to create a TTL on a learner collection even if one is declared", async () => {
    // Enforced at runtime too, not only by the test above — a future edit
    // should be stopped by the code, not just reported by CI.
    const { db, created } = fakeDb();
    const { logger } = await import("./logger.js");
    const original = [...INDEXES.learnerRecord];
    INDEXES.learnerRecord.push({
      collection: "progress",
      keys: { updatedAt: 1 },
      expireAfterSeconds: 60,
      why: "a mistake",
    });

    try {
      await ensureIndexes(db);

      expect(created.some((c) => c.collection === "progress" && JSON.stringify(c.keys) === '{"updatedAt":1}')).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ collection: "progress" }),
        expect.stringMatching(/refusing a TTL/i),
      );
    } finally {
      INDEXES.learnerRecord.length = 0;
      INDEXES.learnerRecord.push(...original);
    }
  });
});

describe("telemetry does expire", () => {
  it("puts a window on the fields that hold a spoken phrase and a device", () => {
    const expiring = INDEXES.telemetry.filter((s) => s.expireAfterSeconds !== undefined);

    expect(expiring.map((s) => s.collection).sort()).toEqual(["attempts", "diagnostics"]);
    // 90 days by default.
    expect(expiring.every((s) => s.expireAfterSeconds === 90 * 86_400)).toBe(true);
  });

  it("expires on createdAt, which is a real Date", () => {
    // `at` is a display-formatted ISO string, and a Mongo TTL index can only
    // expire on an actual Date — which is the entire reason createdAt exists.
    for (const spec of INDEXES.telemetry.filter((s) => s.expireAfterSeconds !== undefined)) {
      expect(Object.keys(spec.keys)).toEqual(["createdAt"]);
    }
  });
});

describe("operational data expires on its own horizon", () => {
  it("uses expireAfterSeconds zero, so each document sets its own", () => {
    // Rather than inheriting the privacy window: these hold counts, not
    // learner content, and want a much shorter life.
    for (const spec of INDEXES.operational) {
      expect(spec.expireAfterSeconds).toBe(0);
      expect(Object.keys(spec.keys)).toEqual(["expiresAt"]);
    }
  });
});

describe("creating them", () => {
  it("creates every declared index", async () => {
    const { db, created } = fakeDb();

    await ensureIndexes(db);

    expect(created).toHaveLength(all.length);
    // Guards against the count being trivially satisfied by an empty
    // declaration list — the aggregate class legitimately has none, so the
    // total has to be checked as more than nothing.
    expect(all.length).toBeGreaterThan(10);
  });

  it("passes the TTL only where one is declared", async () => {
    const { db, created } = fakeDb();

    await ensureIndexes(db);

    const withTtl = created.filter((c) => Object.keys(c.options as object).length > 0);
    expect(withTtl).toHaveLength(all.filter((s) => s.expireAfterSeconds !== undefined).length);
  });

  it("keeps going after one index fails", async () => {
    /**
     * The old shape was one Promise.all with a single catch, so the first
     * failure discarded the outcome of every other index — one conflicting
     * TTL could leave a dozen missing indexes behind a single vague log line.
     */
    const { db, created } = fakeDb({ collection: "attempts", error: new Error("nope") });

    await ensureIndexes(db);

    expect(created.some((c) => c.collection === "diagnostics")).toBe(true);
    expect(created.some((c) => c.collection === "progress")).toBe(true);
  });

  it("never throws, because a missing index is not a correctness problem", async () => {
    // This runs inside getDb(), so an escaping error would fail every request
    // rather than costing query speed.
    const { db } = fakeDb({ collection: "attempts", error: new Error("nope") });

    await expect(ensureIndexes(db)).resolves.toBeUndefined();
  });

  it("names the command to run when a retention change is rejected", async () => {
    /**
     * Mongo rejects a createIndex that changes expireAfterSeconds on an
     * existing index rather than adjusting it, so changing RETENTION_DAYS on a
     * live database is a manual operation. The old message said only "failed
     * to ensure indexes" — true, and useless to whoever has to fix it.
     */
    const { db } = fakeDb({ collection: "attempts", error: conflict() });
    const { logger } = await import("./logger.js");

    await ensureIndexes(db);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ fix: expect.stringContaining("dropIndex") }),
      expect.stringMatching(/has NOT been applied/),
    );
  });
});

describe("every index earns its place", () => {
  it("says why it exists", () => {
    // Whoever reads a slow query later should not have to guess.
    for (const spec of all) {
      expect(spec.why.length, `${spec.collection} ${JSON.stringify(spec.keys)}`).toBeGreaterThan(20);
    }
  });

  it("declares no duplicates", () => {
    const seen = all.map((s) => `${s.collection}/${JSON.stringify(s.keys)}`);

    expect(new Set(seen).size).toBe(seen.length);
  });
});
