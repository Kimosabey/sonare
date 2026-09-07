/**
 * The runner, and the four ways a migration system quietly ruins a database.
 *
 * It can run twice — so a completed migration is recorded the moment it
 * succeeds, not at the end of the run. It can run in two places at once, which
 * is why there is a lock. It can carry on past a failure and apply a later
 * change on top of a schema the earlier one was supposed to produce. And it
 * can hang forever on a lock held by a process that died.
 *
 * All four are exercised here rather than argued about in a comment, because
 * the first time any of them happens is on a real database with real learner
 * history in it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "mongodb";
import { appliedIds, pending, run, validate, type Migration } from "./index.js";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

interface Doc {
  _id: string;
  [key: string]: unknown;
}

let store: Map<string, Doc>;

/** A Db with just the operations the runner uses. */
function fakeDb(): Db {
  return {
    collection: () => ({
      find: () => ({ toArray: () => Promise.resolve([...store.values()]) }),
      insertOne: (doc: Doc) => {
        if (store.has(doc._id)) {
          const err = new Error("E11000 duplicate key") as Error & { code: number };
          err.code = 11000;
          return Promise.reject(err);
        }
        store.set(doc._id, structuredClone(doc));
        return Promise.resolve({ acknowledged: true });
      },
      updateOne: (filter: { _id: string; heldSince?: { $lt: Date } }, update: Record<string, Record<string, unknown>>) => {
        const existing = store.get(filter._id);
        if (existing === undefined) return Promise.resolve({ matchedCount: 0, acknowledged: true });
        if (filter.heldSince !== undefined) {
          const held = existing["heldSince"];
          if (!(held instanceof Date) || held >= filter.heldSince.$lt) {
            return Promise.resolve({ matchedCount: 0, acknowledged: true });
          }
        }
        store.set(filter._id, { ...existing, ...(update["$set"] ?? {}) } as Doc);
        return Promise.resolve({ matchedCount: 1, acknowledged: true });
      },
      deleteOne: (filter: { _id: string }) => {
        store.delete(filter._id);
        return Promise.resolve({ acknowledged: true });
      },
    }),
  } as unknown as Db;
}

/** A migration that records that it ran. */
function migration(id: string, onUp?: () => void | Promise<void>): Migration {
  return {
    id,
    description: `does the thing called ${id}`,
    up: async () => {
      await onUp?.();
    },
  };
}

beforeEach(() => {
  store = new Map();
  vi.clearAllMocks();
});

describe("rejecting a list that cannot be reasoned about", () => {
  it("accepts a well-formed list", () => {
    expect(validate([migration("0001-first"), migration("0002-second")])).toEqual([]);
  });

  it("accepts an empty list", () => {
    expect(validate([])).toEqual([]);
  });

  it("rejects duplicate ids", () => {
    // "Has this run" becomes ambiguous, and one of the two silently never does.
    expect(validate([migration("0001-a"), migration("0001-a")])[0]).toMatch(/duplicate/);
  });

  it("rejects a list that does not read in the order it runs", () => {
    // Obvious in hindsight, invisible in review.
    expect(validate([migration("0002-second"), migration("0001-first")])[0]).toMatch(/sorted/);
  });

  it("rejects an id that is not NNNN-kebab-case", () => {
    for (const id of ["1-first", "first", "0001_First", "0001-First"]) {
      expect(validate([{ ...migration("0001-x"), id }]).join(" ")).toMatch(/NNNN-kebab-case/);
    }
  });

  it("insists on a description that says something", () => {
    expect(validate([{ ...migration("0001-x"), description: "fix" }])[0]).toMatch(/description/);
  });

  it("refuses to run an invalid list, before taking the lock", async () => {
    /**
     * Before the lock, so a bad list cannot block a deployment while somebody
     * is fixing it.
     */
    const db = fakeDb();

    await expect(run(db, [migration("0002-b"), migration("0001-a")])).rejects.toThrow(/invalid/);
    expect(store.has("migrations:lock")).toBe(false);
  });
});

describe("applying", () => {
  it("runs a pending migration and records it", async () => {
    const db = fakeDb();
    const ran: string[] = [];

    const result = await run(db, [migration("0001-first", () => void ran.push("0001-first"))]);

    expect(ran).toEqual(["0001-first"]);
    expect(result.ids).toEqual(["0001-first"]);
    expect(store.get("0001-first")).toMatchObject({ description: expect.any(String) });
  });

  it("runs them in order", async () => {
    const db = fakeDb();
    const ran: string[] = [];

    await run(db, [
      migration("0001-a", () => void ran.push("a")),
      migration("0002-b", () => void ran.push("b")),
      migration("0003-c", () => void ran.push("c")),
    ]);

    expect(ran).toEqual(["a", "b", "c"]);
  });

  it("does not run one twice", async () => {
    // The whole point of recording them.
    const db = fakeDb();
    let count = 0;
    const list = [migration("0001-first", () => void (count += 1))];

    await run(db, list);
    await run(db, list);

    expect(count).toBe(1);
  });

  it("runs only what is new when the list grows", async () => {
    const db = fakeDb();
    const ran: string[] = [];
    await run(db, [migration("0001-a", () => void ran.push("a"))]);

    await run(db, [migration("0001-a", () => void ran.push("a")), migration("0002-b", () => void ran.push("b"))]);

    expect(ran).toEqual(["a", "b"]);
  });

  it("does nothing when everything is applied", async () => {
    const db = fakeDb();
    const list = [migration("0001-a")];
    await run(db, list);

    expect((await run(db, list)).ids).toEqual([]);
  });

  it("releases the lock when it finishes", async () => {
    const db = fakeDb();

    await run(db, [migration("0001-a")]);

    expect(store.has("migrations:lock")).toBe(false);
  });

  it("does not count the lock as an applied migration", async () => {
    /**
     * The lock lives in the same collection, so a naive "everything in here
     * has been applied" would treat it as a migration named
     * `migrations:lock` — and the real one with that id would be skipped
     * forever.
     */
    const db = fakeDb();
    store.set("migrations:lock", { _id: "migrations:lock", heldSince: new Date(), by: "someone" });

    expect(await appliedIds(db)).toEqual(new Set());
  });
});

describe("stopping at a failure", () => {
  it("does not apply anything after the one that failed", async () => {
    /**
     * Continuing would apply a later migration on top of a schema the earlier
     * one was supposed to produce, turning a clear failure into a corrupt
     * state.
     */
    const db = fakeDb();
    const ran: string[] = [];

    const result = await run(db, [
      migration("0001-a", () => void ran.push("a")),
      { id: "0002-b", description: "the one that fails", up: () => Promise.reject(new Error("boom")) },
      migration("0003-c", () => void ran.push("c")),
    ]);

    expect(ran).toEqual(["a"]);
    expect(result.failed).toEqual({ id: "0002-b", message: "boom" });
    expect(result.ids).toEqual(["0001-a"]);
  });

  it("keeps the successful ones recorded, so a retry resumes", async () => {
    const db = fakeDb();
    const list: Migration[] = [
      migration("0001-a"),
      { id: "0002-b", description: "the one that fails", up: () => Promise.reject(new Error("boom")) },
    ];
    await run(db, list);

    expect(await appliedIds(db)).toEqual(new Set(["0001-a"]));
    expect((await pending(db, list)).map((m) => m.id)).toEqual(["0002-b"]);
  });

  it("releases the lock even on failure", async () => {
    // The lock serialises runners; it is not a record that something went
    // wrong. Holding it would block every later deployment on a problem that
    // has already been logged.
    const db = fakeDb();

    await run(db, [{ id: "0001-a", description: "the one that fails", up: () => Promise.reject(new Error("boom")) }]);

    expect(store.has("migrations:lock")).toBe(false);
  });

  it("reports a thrown non-Error readably", async () => {
    const db = fakeDb();

    const result = await run(db, [
      // Rejecting with a string on purpose: a migration written by hand can
      // throw anything, and the runner has to report it readably rather than
      // logging "undefined".
      { id: "0001-a", description: "throws a string", up: () => Promise.reject("just a string") },
    ]);

    expect(result.failed?.message).toBe("just a string");
  });
});

describe("the lock", () => {
  it("skips when another process holds it", async () => {
    /**
     * Two instances starting together must not both migrate. Skipping is the
     * right answer rather than failing — a rolling deployment should proceed,
     * not fail every instance but one.
     */
    const db = fakeDb();
    store.set("migrations:lock", { _id: "migrations:lock", heldSince: new Date(), by: "the other one" });
    let ran = false;

    const result = await run(db, [migration("0001-a", () => void (ran = true))]);

    expect(result.skippedLocked).toBe(true);
    expect(ran).toBe(false);
  });

  it("does not release a lock it did not take", async () => {
    // Otherwise the loser of the race would free the winner's lock mid-run.
    const db = fakeDb();
    store.set("migrations:lock", { _id: "migrations:lock", heldSince: new Date(), by: "the other one" });

    await run(db, [migration("0001-a")]);

    expect(store.get("migrations:lock")).toMatchObject({ by: "the other one" });
  });

  it("reclaims a lock left behind by a dead process", async () => {
    /**
     * Without this, a process killed mid-migration blocks every future
     * deployment on a lock nobody holds — and the fix would be a manual
     * database edit under exactly the time pressure that produces mistakes.
     */
    const db = fakeDb();
    const ancient = new Date(Date.now() - 60 * 60 * 1000);
    store.set("migrations:lock", { _id: "migrations:lock", heldSince: ancient, by: "a process that died" });
    let ran = false;

    const result = await run(db, [migration("0001-a", () => void (ran = true))], { by: "me" });

    expect(ran).toBe(true);
    expect(result.ids).toEqual(["0001-a"]);
  });

  it("does not reclaim a lock that is merely a few minutes old", async () => {
    // The failure mode of expiring too early is two runners at once, which is
    // the thing the lock exists to prevent.
    const db = fakeDb();
    store.set("migrations:lock", {
      _id: "migrations:lock",
      heldSince: new Date(Date.now() - 60_000),
      by: "still working",
    });

    expect((await run(db, [migration("0001-a")])).skippedLocked).toBe(true);
  });

  it("records who holds it", async () => {
    const db = fakeDb();
    let holder: unknown;

    await run(db, [migration("0001-a", () => void (holder = store.get("migrations:lock")?.["by"]))], {
      by: "npm run migrate",
    });

    expect(holder).toBe("npm run migrate");
  });
});

describe("a dry run", () => {
  it("reports what would run and changes nothing", async () => {
    const db = fakeDb();
    let ran = false;

    const result = await run(db, [migration("0001-a", () => void (ran = true))], { dryRun: true });

    expect(result).toEqual({ ids: ["0001-a"], dryRun: true });
    expect(ran).toBe(false);
    expect(store.size).toBe(0);
  });

  it("takes no lock, so it cannot block a real run", async () => {
    const db = fakeDb();

    await run(db, [migration("0001-a")], { dryRun: true });

    expect(store.has("migrations:lock")).toBe(false);
  });

  it("reports nothing when there is nothing to do", async () => {
    const db = fakeDb();

    expect((await run(db, [], { dryRun: true })).ids).toEqual([]);
  });

  it("lists only what is still pending", async () => {
    const db = fakeDb();
    const list = [migration("0001-a"), migration("0002-b")];
    await run(db, [list[0] as Migration]);

    expect((await run(db, list, { dryRun: true })).ids).toEqual(["0002-b"]);
  });
});
