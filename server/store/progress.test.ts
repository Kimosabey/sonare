/**
 * The read-modify-write that sync is built on, and the lost update hiding in it.
 *
 * Merging needs the current state, so the operation spans a read and a write —
 * and single-document atomicity does not cover that. Two devices pushing at
 * once can both read the same document, and the second write discards the
 * first's contribution with nothing to show it happened.
 *
 * The version guard is what prevents it, so these tests interleave the two
 * writers deliberately rather than hoping for a race: the mock lets a test
 * commit a competing write in the window between another caller's read and its
 * update.
 *
 * The guard itself now lives in mergeStore.ts, shared by all three synced
 * domains. These cases were written against progress and kept here unchanged
 * when it moved — they still pass, which is what says the extraction preserved
 * the behaviour rather than merely compiling.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProgressEntry } from "../domain/merge.js";

interface Doc {
  _id: string;
  learnerId: string;
  slug: string;
  entries: ProgressEntry[];
  version: number;
  updatedAt: Date;
}

let store: Map<string, Doc>;
/** Runs once, in the window between the next findOne and its updateOne. */
let interleave: (() => void) | null = null;

vi.mock("../db.js", () => ({
  getDb: () =>
    Promise.resolve({
      collection: () => ({
        findOne: (filter: { _id: string }) => {
          const found = store.get(filter._id) ?? null;
          if (interleave !== null) {
            const run = interleave;
            interleave = null;
            run();
          }
          return Promise.resolve(found === null ? null : structuredClone(found));
        },
        find: (filter: { learnerId: string }) => ({
          toArray: () =>
            Promise.resolve([...store.values()].filter((d) => d.learnerId === filter.learnerId)),
        }),
        insertOne: (doc: Doc) => {
          if (store.has(doc._id)) {
            const err = new Error("E11000 duplicate key") as Error & { code: number };
            err.code = 11000;
            return Promise.reject(err);
          }
          store.set(doc._id, structuredClone(doc));
          return Promise.resolve({ acknowledged: true });
        },
        updateOne: (
          filter: { _id: string; version?: number },
          update: Record<string, Record<string, unknown>>,
        ) => {
          const existing = store.get(filter._id);
          if (existing === undefined || (filter.version !== undefined && existing.version !== filter.version)) {
            return Promise.resolve({ matchedCount: 0, acknowledged: true });
          }
          const set = (update["$set"] ?? {}) as Partial<Doc>;
          store.set(filter._id, { ...existing, ...set, version: existing.version + 1 });
          return Promise.resolve({ matchedCount: 1, acknowledged: true });
        },
        deleteMany: (filter: { learnerId: string }) => {
          for (const [k, v] of store) if (v.learnerId === filter.learnerId) store.delete(k);
          return Promise.resolve({ acknowledged: true });
        },
      }),
    }),
}));

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const LEARNER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER = "11111111-2222-4333-8444-555555555555";

function entry(over: Partial<ProgressEntry> = {}): ProgressEntry {
  return {
    activityId: 1,
    passed: false,
    bestAccuracy: null,
    attemptsUsed: 0,
    skipped: false,
    at: "2026-09-07T10:00:00.000Z",
    ...over,
  };
}

async function load() {
  vi.resetModules();
  return import("./progress.js");
}

/** Writes a document straight in, as another device would have. */
function seed(learnerId: string, slug: string, entries: ProgressEntry[], version = 1): void {
  store.set(`${learnerId}:${slug}`, {
    _id: `${learnerId}:${slug}`,
    learnerId,
    slug,
    entries,
    version,
    updatedAt: new Date(),
  });
}

beforeEach(() => {
  store = new Map();
  interleave = null;
  vi.clearAllMocks();
});

describe("first push", () => {
  it("creates the document and returns the merged state", async () => {
    const { mergeAndSaveProgress } = await load();

    const result = await mergeAndSaveProgress(LEARNER, {
      slug: "fr",
      entries: [entry({ activityId: 1, passed: true, bestAccuracy: 77 })],
    });

    expect(result.entries).toHaveLength(1);
    expect(store.get(`${LEARNER}:fr`)?.version).toBe(1);
  });

  it("keys per learner and per language", async () => {
    const { mergeAndSaveProgress, readProgress } = await load();

    await mergeAndSaveProgress(LEARNER, { slug: "fr", entries: [entry({ passed: true })] });
    await mergeAndSaveProgress(LEARNER, { slug: "es", entries: [entry()] });
    await mergeAndSaveProgress(OTHER, { slug: "fr", entries: [entry()] });

    expect((await readProgress(LEARNER, "fr"))?.entries[0]?.passed).toBe(true);
    expect((await readProgress(OTHER, "fr"))?.entries[0]?.passed).toBe(false);
    expect(await readProgress(OTHER, "de")).toBeNull();
  });
});

describe("a push is also a pull", () => {
  it("returns the merged state, so one round trip settles both sides", async () => {
    /**
     * A client that pushed stale data learns the truth immediately rather than
     * on some later poll — which is what lets the local store be authoritative
     * for the session without drifting.
     */
    seed(LEARNER, "fr", [entry({ activityId: 2, passed: true, bestAccuracy: 91 })]);
    const { mergeAndSaveProgress } = await load();

    const result = await mergeAndSaveProgress(LEARNER, {
      slug: "fr",
      entries: [entry({ activityId: 1, passed: true })],
    });

    expect(result.entries.map((e) => e.activityId)).toEqual([1, 2]);
  });

  it("does not let a stale push undo a stored pass", async () => {
    seed(LEARNER, "fr", [entry({ activityId: 1, passed: true, bestAccuracy: 88 })]);
    const { mergeAndSaveProgress } = await load();

    const result = await mergeAndSaveProgress(LEARNER, {
      slug: "fr",
      entries: [entry({ activityId: 1, passed: false, bestAccuracy: 20 })],
    });

    expect(result.entries[0]).toMatchObject({ passed: true, bestAccuracy: 88 });
  });
});

describe("two devices at once", () => {
  it("does not lose the write that landed first", async () => {
    /**
     * The lost update, staged rather than hoped for. The competing write
     * commits in the window between this caller's read and its update, so
     * without the version guard this push would overwrite it and activity 2
     * would simply vanish.
     */
    seed(LEARNER, "fr", [entry({ activityId: 1, passed: true })]);
    const { mergeAndSaveProgress } = await load();

    interleave = () => {
      const doc = store.get(`${LEARNER}:fr`);
      if (doc === undefined) return;
      store.set(doc._id, {
        ...doc,
        entries: [...doc.entries, entry({ activityId: 2, passed: true })],
        version: doc.version + 1,
      });
    };

    const result = await mergeAndSaveProgress(LEARNER, {
      slug: "fr",
      entries: [entry({ activityId: 3, passed: true })],
    });

    expect(result.entries.map((e) => e.activityId)).toEqual([1, 2, 3]);
    expect(store.get(`${LEARNER}:fr`)?.entries.map((e) => e.activityId)).toEqual([1, 2, 3]);
  });

  it("retries rather than failing on a single conflict", async () => {
    seed(LEARNER, "fr", [entry({ activityId: 1 })]);
    const { mergeAndSaveProgress } = await load();

    interleave = () => {
      const doc = store.get(`${LEARNER}:fr`);
      if (doc !== undefined) store.set(doc._id, { ...doc, version: doc.version + 1 });
    };

    await expect(
      mergeAndSaveProgress(LEARNER, { slug: "fr", entries: [entry({ activityId: 2 })] }),
    ).resolves.toBeDefined();
  });

  it("gives up rather than spinning when contention never clears", async () => {
    /**
     * An unbounded retry loop is a worse failure than a rejected push: the
     * client keeps its local state, stays dirty and pushes again, which is
     * exactly what it does for any other failure. Nothing is lost.
     */
    seed(LEARNER, "fr", [entry()]);
    const { mergeAndSaveProgress } = await load();

    // Bump the version on every read, so no update ever matches.
    let bumps = 0;
    const bumpForever = (): void => {
      const doc = store.get(`${LEARNER}:fr`);
      if (doc !== undefined) store.set(doc._id, { ...doc, version: doc.version + 1 });
      bumps += 1;
      interleave = bumpForever;
    };
    interleave = bumpForever;

    await expect(
      mergeAndSaveProgress(LEARNER, { slug: "fr", entries: [entry({ activityId: 9 })] }),
    ).rejects.toThrow(/version races/);
    expect(bumps).toBeGreaterThanOrEqual(4);
  });

  it("merges rather than overwriting when another device creates the document first", async () => {
    // The insert races too. It must fail and re-read, not upsert over the top.
    const { mergeAndSaveProgress } = await load();

    interleave = () => {
      seed(LEARNER, "fr", [entry({ activityId: 5, passed: true })]);
    };

    const result = await mergeAndSaveProgress(LEARNER, {
      slug: "fr",
      entries: [entry({ activityId: 1, passed: true })],
    });

    expect(result.entries.map((e) => e.activityId)).toEqual([1, 5]);
  });
});

describe("reading everything", () => {
  it("returns every language a learner has touched", async () => {
    seed(LEARNER, "fr", [entry()]);
    seed(LEARNER, "es", [entry()]);
    seed(OTHER, "de", [entry()]);
    const { readAllProgress } = await load();

    const all = await readAllProgress(LEARNER);

    expect(all.map((s) => s.slug).sort()).toEqual(["es", "fr"]);
  });

  it("returns nothing for a learner with no history", async () => {
    const { readAllProgress } = await load();

    expect(await readAllProgress(LEARNER)).toEqual([]);
  });
});

describe("deleting", () => {
  it("removes every language for one learner and nobody else's", async () => {
    seed(LEARNER, "fr", [entry()]);
    seed(LEARNER, "es", [entry()]);
    seed(OTHER, "fr", [entry()]);
    const { deleteProgress, readAllProgress } = await load();

    await deleteProgress(LEARNER);

    expect(await readAllProgress(LEARNER)).toEqual([]);
    expect(await readAllProgress(OTHER)).toHaveLength(1);
  });
});
