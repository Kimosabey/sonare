/**
 * The optimistic-concurrency loop under real contention, not scripted races.
 *
 * mergeStore.ts states three things and proves none of them: that the version
 * guard stops a lost update, that retries stay bounded, and that the result
 * converges whatever order the devices pushed in. store/progress.test.ts
 * checks the first with a hand-placed interleave — one competing write
 * committed in a known window — which is the right way to pin a known race and
 * says nothing about many writers at once.
 *
 * So the mock here does not script anything. `findOne`, `insertOne` and
 * `updateOne` each yield to the event loop before they take effect, which is
 * what a network round trip does, and N calls to `mergeAndSave` launched
 * together therefore genuinely interleave: they read the same version, they
 * all try to write it, and one of them wins.
 *
 * That makes the outcome scheduler-dependent, so the assertions are invariants
 * rather than counts. The one that matters is this: a writer either resolves,
 * in which case its contribution is in the document, or it rejects, in which
 * case the client still holds its state and pushes again. What must never
 * happen is a writer resolving while its contribution is gone — that is the
 * lost update, and it is silent.
 *
 * The mock models the three driver behaviours the loop actually depends on:
 * `insertOne` rejects a duplicate `_id` with code 11000 (which is how the
 * insert race is detected at all), `updateOne` matches only on an exact
 * `version` (which is the guard), and both return documents by value so a
 * caller cannot mutate stored state through a reference it was handed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mergeStreaks, type StreakState } from "../domain/merge.js";
import type { MergeRequest, VersionedDocument } from "./mergeStore.js";

interface Doc {
  _id: string;
  learnerId?: string;
  version?: number;
  days?: string[];
  longest?: number;
  updatedAt?: Date;
}

let store: Map<string, Doc>;

/** Every operation the loop performed, so retries can be counted. */
let calls: { findOne: number; insertOne: number; updateOne: number };

/** When set, every updateOne reports a miss — the worst case for the loop. */
let refuseEveryUpdate = false;

/**
 * A round trip. Without it every `mergeAndSave` would run its read and its
 * write in one uninterrupted microtask run and the "concurrent" writers would
 * simply queue up, which is the shape of test that reports no contention
 * because it created none.
 */
function roundTrip(): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, 0);
  });
}

vi.mock("../db.js", () => ({
  getDb: () =>
    Promise.resolve({
      collection: (name: string) => ({
        findOne: async (filter: { _id: string }) => {
          calls.findOne += 1;
          await roundTrip();
          const found = store.get(`${name}/${filter._id}`);
          // By value. A caller holding a reference into the store would see
          // another writer's commit appear inside state it had already read,
          // which no database does.
          return found === undefined ? null : structuredClone(found);
        },
        insertOne: async (doc: Doc) => {
          calls.insertOne += 1;
          await roundTrip();
          const key = `${name}/${doc._id}`;
          if (store.has(key)) {
            // The duplicate-key rejection is the whole mechanism by which a
            // losing insert becomes a retry instead of an overwrite.
            const err = new Error("E11000 duplicate key error") as Error & { code: number };
            err.code = 11000;
            throw err;
          }
          store.set(key, structuredClone(doc));
          return { acknowledged: true };
        },
        updateOne: async (
          filter: { _id: string; version?: number },
          update: { $set?: Record<string, unknown>; $inc?: Record<string, number> },
        ) => {
          calls.updateOne += 1;
          await roundTrip();
          const key = `${name}/${filter._id}`;
          const existing = store.get(key);
          if (existing === undefined) return { matchedCount: 0, acknowledged: true };
          if (refuseEveryUpdate) return { matchedCount: 0, acknowledged: true };
          // The guard. An exact match on the version that was read, so a
          // writer whose read is stale by even one commit cannot land.
          if (filter.version !== undefined && existing.version !== filter.version) {
            return { matchedCount: 0, acknowledged: true };
          }
          const next: Doc = { ...existing, ...(update.$set ?? {}) };
          for (const [field, by] of Object.entries(update.$inc ?? {})) {
            next[field as "version"] = ((existing[field as "version"] ?? 0) as number) + by;
          }
          store.set(key, structuredClone(next));
          return { matchedCount: 1, acknowledged: true };
        },
        deleteMany: async (filter: { learnerId?: string; _id?: { $regex: string } }) => {
          await roundTrip();
          let deletedCount = 0;
          for (const [key, doc] of store) {
            if (!key.startsWith(`${name}/`)) continue;
            /**
             * Both filter shapes `deleteAllFor` uses, because it makes two
             * passes: one on the `learnerId` field and one on an anchored
             * `_id` pattern for documents attributed by their key alone. A
             * mock that only understood the field would report the second
             * pass as a no-op and hide whether it works.
             */
            const byField = filter.learnerId !== undefined && doc.learnerId === filter.learnerId;
            const byId = filter._id !== undefined && new RegExp(filter._id.$regex).test(doc._id);
            if (byField || byId) {
              store.delete(key);
              deletedCount += 1;
            }
          }
          return { acknowledged: true, deletedCount };
        },
        find: (filter: { learnerId: string }) => ({
          toArray: async () => {
            await roundTrip();
            return [...store.entries()]
              .filter(([key, doc]) => key.startsWith(`${name}/`) && doc.learnerId === filter.learnerId)
              .map(([, doc]) => structuredClone(doc));
          },
        }),
      }),
    }),
}));

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const LEARNER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER = "11111111-2222-4333-8444-555555555555";

async function load() {
  vi.resetModules();
  return import("./mergeStore.js");
}

/**
 * Streaks as the subject, because a day is the least forgiving thing to lose.
 * It is also the domain whose document is keyed on the bare learner id, so
 * every device in a test contends for exactly one document.
 */
function streakRequest(learnerId: string, incoming: StreakState): MergeRequest<StreakState> {
  return {
    collection: "streaks",
    id: learnerId,
    learnerId,
    incoming,
    merge: mergeStreaks,
    empty: { days: [], longest: 0 },
    toFields: (state) => ({ days: state.days, longest: state.longest }),
    // The same tolerant read store/streaks.ts uses, so a seeded old shape is
    // handled here exactly as the real caller would handle it.
    fromDocument: (doc: VersionedDocument): StreakState => ({
      days: Array.isArray(doc["days"]) ? (doc["days"] as string[]) : [],
      longest: typeof doc["longest"] === "number" ? doc["longest"] : 0,
    }),
  };
}

/** `2026-09-DD`, so a writer's contribution is identifiable in the document. */
function day(n: number): string {
  return `2026-09-${String(n).padStart(2, "0")}`;
}

function storedDays(learnerId = LEARNER): string[] {
  return (store.get(`streaks/${learnerId}`)?.days ?? []).slice().sort();
}

beforeEach(() => {
  store = new Map();
  calls = { findOne: 0, insertOne: 0, updateOne: 0 };
  refuseEveryUpdate = false;
  vi.clearAllMocks();
});

describe("many devices pushing to one learner record at once", () => {
  it("loses nothing that it told a device had been saved", async () => {
    /**
     * The invariant the whole file exists for, stated so that no scheduling
     * order can make it vacuous: every writer that *resolved* has its day in
     * the document, and every writer that *rejected* does not. A resolved
     * writer whose day is missing is the lost update — the client has thrown
     * its dirty flag away and the practice is gone with nothing to show it.
     */
    const { mergeAndSave } = await load();
    const writers = [1, 2, 3, 4].map((n) =>
      mergeAndSave(streakRequest(LEARNER, { days: [day(n)], longest: 1 })),
    );

    const outcomes = await Promise.allSettled(writers);
    const stored = storedDays();

    outcomes.forEach((outcome, i) => {
      if (outcome.status === "fulfilled") {
        expect(stored).toContain(day(i + 1));
        /**
         * What the client is handed is the state as of its own commit: its own
         * day, plus whatever had already landed. Not the state as of the end
         * of the batch — a writer that commits first cannot know about one
         * that commits after it, and claiming otherwise would be asserting
         * something no database does.
         *
         * The property that matters is that it is never *more* than the truth:
         * every day reported to a device is really in the document.
         */
        expect(outcome.value.days).toContain(day(i + 1));
        for (const reported of outcome.value.days) expect(stored).toContain(reported);
      } else {
        expect(stored).not.toContain(day(i + 1));
      }
    });
  });

  it("saves all four days when four devices push together", async () => {
    /**
     * Stronger than the invariant above and the reason MERGE_MAX_ATTEMPTS is
     * 4: the documented worst case is every device reading the same version,
     * which costs one attempt per device. Four concurrent writers therefore
     * all land. Asserted separately from the invariant so that a change which
     * quietly starts rejecting ordinary pushes fails here rather than passing
     * a test that tolerates rejection.
     */
    const { mergeAndSave } = await load();

    await Promise.all(
      [1, 2, 3, 4].map((n) => mergeAndSave(streakRequest(LEARNER, { days: [day(n)], longest: 1 }))),
    );

    expect(storedDays()).toEqual([day(1), day(2), day(3), day(4)]);
  });

  it("refuses rather than spins when contention exceeds the retry budget", async () => {
    /**
     * The other half of "bounded": a rejected push is the intended failure.
     * The client keeps its local state, stays dirty and pushes again, which is
     * strictly better than a loop that cannot end.
     *
     * Twelve writers on one document, so some are certain to exhaust the
     * budget. What is asserted is the shape of the failure, not how many fail:
     * every rejection names the collection and the document, and — the part
     * that matters — nothing a rejected writer pushed is in the document.
     */
    const { mergeAndSave, MERGE_MAX_ATTEMPTS } = await load();
    const days = Array.from({ length: 12 }, (_, i) => day(i + 1));

    const outcomes = await Promise.allSettled(
      days.map((d) => mergeAndSave(streakRequest(LEARNER, { days: [d], longest: 1 }))),
    );
    const stored = storedDays();

    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(rejected.length).toBeGreaterThan(0);
    for (const outcome of rejected) {
      expect((outcome.reason as Error).message).toBe(
        `streaks merge for ${LEARNER} lost ${MERGE_MAX_ATTEMPTS} version races`,
      );
    }
    outcomes.forEach((outcome, i) => {
      if (outcome.status === "fulfilled") expect(stored).toContain(days[i]);
      else expect(stored).not.toContain(days[i]);
    });
  });

  it("reads at most once per attempt, and never more than the budget", async () => {
    // Bounded in operations, not just in outcome: a loop that retried inside
    // the loop, or one whose bound was off by one, would show up here.
    const { mergeAndSave, MERGE_MAX_ATTEMPTS } = await load();
    refuseEveryUpdate = true;
    store.set(`streaks/${LEARNER}`, { _id: LEARNER, learnerId: LEARNER, days: [day(1)], longest: 1, version: 1 });

    await expect(mergeAndSave(streakRequest(LEARNER, { days: [day(2)], longest: 1 }))).rejects.toThrow(
      `lost ${MERGE_MAX_ATTEMPTS} version races`,
    );

    expect(calls.findOne).toBe(MERGE_MAX_ATTEMPTS);
    expect(calls.updateOne).toBe(MERGE_MAX_ATTEMPTS);
    // And the stored document is untouched: a merge that cannot commit must
    // not have committed part of itself.
    expect(storedDays()).toEqual([day(1)]);
  });

  it("keeps one learner's contention out of another's document", async () => {
    const { mergeAndSave } = await load();

    await Promise.all([
      ...[1, 2, 3].map((n) => mergeAndSave(streakRequest(LEARNER, { days: [day(n)], longest: 1 }))),
      ...[7, 8].map((n) => mergeAndSave(streakRequest(OTHER, { days: [day(n)], longest: 1 }))),
    ]);

    expect(storedDays(LEARNER)).toEqual([day(1), day(2), day(3)]);
    expect(storedDays(OTHER)).toEqual([day(7), day(8)]);
  });
});

describe("two devices creating the record at the same time", () => {
  it("merges into the winner's document instead of overwriting it", async () => {
    /**
     * The insert race, and the reason mergeStore uses a plain insert rather
     * than an upsert: the insert has to *fail* so the loser re-reads and
     * merges. An upsert with `$set` would have replaced the winner's document
     * with the loser's state and lost a practice day, with both devices
     * reporting success.
     */
    const { mergeAndSave } = await load();

    const [first, second] = await Promise.all([
      mergeAndSave(streakRequest(LEARNER, { days: [day(1)], longest: 1 })),
      mergeAndSave(streakRequest(LEARNER, { days: [day(2)], longest: 1 })),
    ]);

    expect(storedDays()).toEqual([day(1), day(2)]);
    // One inserted and one lost the insert, so exactly one update followed.
    expect(calls.insertOne).toBe(2);
    expect(calls.updateOne).toBe(1);
    // Whichever of the two ran second sees both days; the other sees its own
    // and learns the rest on its next round trip.
    expect([first.days.length, second.days.length].sort()).toEqual([1, 2]);
    expect(store.get(`streaks/${LEARNER}`)?.version).toBe(2);
  });

  it("attributes a document created under contention to the right learner", async () => {
    // `learnerId` is the field every pull and every deletion filters on. A
    // document created down the retry path that lacked it would be invisible
    // to both while its `_id` went on naming the learner.
    const { mergeAndSave } = await load();

    await Promise.all(
      [1, 2, 3].map((n) => mergeAndSave(streakRequest(LEARNER, { days: [day(n)], longest: 1 }))),
    );

    expect(store.get(`streaks/${LEARNER}`)?.learnerId).toBe(LEARNER);
  });
});

describe("the same set of pushes, applied in every order", () => {
  it("converges on one document whichever device went first", async () => {
    /**
     * Commutativity through the store rather than in the pure functions: the
     * same four pushes, applied in all 24 orders against a fresh database, and
     * one answer. This is what makes a version conflict safe to resolve by
     * re-reading and merging again — there is no ordering that produces a
     * different record, so nothing has to be asked of the learner.
     */
    const { mergeAndSave } = await load();
    const pushes: StreakState[] = [
      { days: [day(1), day(2)], longest: 2 },
      { days: [day(2), day(3)], longest: 2 },
      { days: [day(6)], longest: 1 },
      { days: [day(1), day(6)], longest: 1 },
    ];

    const orders: StreakState[][] = [];
    const permute = (chosen: StreakState[], rest: StreakState[]): void => {
      if (rest.length === 0) {
        orders.push(chosen);
        return;
      }
      rest.forEach((push, i) => permute([...chosen, push], [...rest.slice(0, i), ...rest.slice(i + 1)]));
    };
    permute([], pushes);
    expect(orders).toHaveLength(24);

    const results = new Set<string>();
    for (const order of orders) {
      store = new Map();
      for (const push of order) await mergeAndSave(streakRequest(LEARNER, push));
      const doc = store.get(`streaks/${LEARNER}`);
      results.add(JSON.stringify({ days: doc?.days, longest: doc?.longest }));
    }

    expect([...results]).toEqual([JSON.stringify({ days: [day(1), day(2), day(3), day(6)], longest: 3 })]);
  });

  it("reaches the same document under concurrency as it does in sequence", async () => {
    // The version guard is only worth having if racing produces the same
    // record as not racing. Same four pushes, once serialised and once all at
    // the same time.
    const { mergeAndSave } = await load();
    const pushes: StreakState[] = [
      { days: [day(1)], longest: 1 },
      { days: [day(2)], longest: 1 },
      { days: [day(3)], longest: 1 },
      { days: [day(4)], longest: 1 },
    ];

    for (const push of pushes) await mergeAndSave(streakRequest(LEARNER, push));
    const sequential = storedDays();

    store = new Map();
    await Promise.all(pushes.map((push) => mergeAndSave(streakRequest(LEARNER, push))));

    expect(storedDays()).toEqual(sequential);
  });
});

describe("pushing the same state twice", () => {
  it("changes nothing the second time", async () => {
    /**
     * Idempotency at the store, which is what makes a client's retry after a
     * timeout safe. The document's version and timestamp move — a write did
     * happen — but nothing the learner would recognise as their record does.
     */
    const { mergeAndSave } = await load();
    const push: StreakState = { days: [day(1), day(2)], longest: 2 };

    const first = await mergeAndSave(streakRequest(LEARNER, push));
    const afterFirst = structuredClone(store.get(`streaks/${LEARNER}`));
    const second = await mergeAndSave(streakRequest(LEARNER, push));
    const afterSecond = store.get(`streaks/${LEARNER}`);

    expect(second).toEqual(first);
    expect(afterSecond?.days).toEqual(afterFirst?.days);
    expect(afterSecond?.longest).toBe(afterFirst?.longest);
    // The write is real, so the version moves. That is the honest report: a
    // no-op merge is still a round trip that committed.
    expect(afterSecond?.version).toBe(2);
  });

  it("changes nothing when the same state arrives four times at once", async () => {
    const { mergeAndSave } = await load();
    const push: StreakState = { days: [day(1), day(2)], longest: 2 };

    const outcomes = await Promise.allSettled(
      [0, 1, 2, 3].map(() => mergeAndSave(streakRequest(LEARNER, push))),
    );

    for (const outcome of outcomes) {
      expect(outcome.status).toBe("fulfilled");
    }
    expect(storedDays()).toEqual([day(1), day(2)]);
    expect(store.get(`streaks/${LEARNER}`)?.longest).toBe(2);
  });
});

describe("a document written before `learnerId` existed", () => {
  it("is repaired by the next merge, so a pull and a deletion can find it", async () => {
    /**
     * A latent leak of exactly the class the rate limiter shipped once: the
     * learner id was in the document's `_id` and nowhere queryable.
     *
     * `readAllFor` and `deleteAllFor` both filter on the `learnerId` *field*.
     * Nothing queries `_id`. So a document without the field was invisible to
     * a pull and stepped straight over by a deletion request, while its id
     * went on naming the learner — and only the insert set it, so an older
     * shape stayed that way forever. The update path now rewrites it, which
     * means the first merge after this change fixes the document rather than
     * leaving it for a migration.
     */
    const { mergeAndSave, readAllFor, deleteAllFor } = await load();
    store.set(`streaks/${LEARNER}`, { _id: LEARNER, days: [day(1)], longest: 1, version: 1 });

    // Before: the document exists and belongs to nobody findable.
    expect(await readAllFor("streaks", LEARNER, (doc) => doc)).toEqual([]);

    await mergeAndSave(streakRequest(LEARNER, { days: [day(2)], longest: 1 }));

    expect(store.get(`streaks/${LEARNER}`)?.learnerId).toBe(LEARNER);
    expect(await readAllFor("streaks", LEARNER, (doc) => doc)).toHaveLength(1);

    await deleteAllFor("streaks", LEARNER);

    expect(store.get(`streaks/${LEARNER}`)).toBeUndefined();
  });

  it("is erased by a deletion even if nothing ever repairs it", async () => {
    /**
     * The repair above only happens on a merge, and a language a learner has
     * stopped practising never gets one. So a deletion request has to reach a
     * document that is attributable from its key and nowhere else — the leak
     * the rate limiter shipped, in the collections that were not the rate
     * limiter.
     */
    const { deleteAllFor } = await load();
    store.set(`streaks/${LEARNER}`, { _id: LEARNER, days: [day(1)], longest: 1, version: 1 });
    store.set(`progress/${LEARNER}:de`, { _id: `${LEARNER}:de`, version: 1 });
    // Another learner's document, to prove the id anchor only matches its own
    // key segment rather than deleting by prefix wherever it happens to fit.
    store.set(`progress/${OTHER}:de`, { _id: `${OTHER}:de`, version: 1 });

    await deleteAllFor("streaks", LEARNER);
    await deleteAllFor("progress", LEARNER);

    expect(store.get(`streaks/${LEARNER}`)).toBeUndefined();
    expect(store.get(`progress/${LEARNER}:de`)).toBeUndefined();
    expect(store.get(`progress/${OTHER}:de`)).toBeDefined();
  });

  it("does not lose the days that document already held", async () => {
    // Repairing attribution must not be a rewrite: the practice in the old
    // document is the whole reason not to just delete it.
    const { mergeAndSave } = await load();
    store.set(`streaks/${LEARNER}`, { _id: LEARNER, days: [day(1)], longest: 1, version: 1 });

    await mergeAndSave(streakRequest(LEARNER, { days: [day(2)], longest: 1 }));

    expect(storedDays()).toEqual([day(1), day(2)]);
  });
});
