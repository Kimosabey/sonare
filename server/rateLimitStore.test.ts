/**
 * The limiter that has to outlive a restart.
 *
 * `express-rate-limit` with no store uses its in-memory default, so before
 * this the ceiling on an open proxy to a metered API reset every deploy and
 * doubled with every extra instance. Neither hole is visible from outside —
 * they show up on a bill.
 *
 * Two properties are pinned here. The count is shared, so a second store
 * object (standing in for a second process) continues the same window rather
 * than starting a fresh one. And when the shared store is unreachable the
 * limit still exists, because a database outage must not become an open door;
 * it degrades to what shipped before, not to nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Options } from "express-rate-limit";

interface Doc {
  _id: string;
  hits: number;
  expiresAt: Date;
}

let store: Map<string, Doc>;
let failWith: Error | null = null;
/** Set to return null from findOneAndUpdate without throwing. */
let returnNothing = false;

function applyInc(existing: Doc | undefined, id: string, update: Record<string, Record<string, unknown>>): Doc {
  const inc = update["$inc"] ?? {};
  const onInsert = update["$setOnInsert"] ?? {};
  const base: Record<string, unknown> = existing ? { ...existing } : { _id: id, hits: 0, ...onInsert };
  for (const [k, v] of Object.entries(inc)) base[k] = ((base[k] as number) ?? 0) + (v as number);
  return base as unknown as Doc;
}

vi.mock("./db.js", () => ({
  getDb: () => {
    if (failWith) return Promise.reject(failWith);
    return Promise.resolve({
      collection: () => ({
        findOneAndUpdate: (
          filter: { _id: string },
          update: Record<string, Record<string, unknown>>,
        ) => {
          if (returnNothing) return Promise.resolve(null);
          const next = applyInc(store.get(filter._id), filter._id, update);
          store.set(filter._id, next);
          return Promise.resolve(next);
        },
        updateOne: (filter: { _id: string; hits?: { $gt: number } }, update: Record<string, Record<string, unknown>>) => {
          const existing = store.get(filter._id);
          if (existing === undefined) return Promise.resolve({ acknowledged: true });
          if (filter.hits !== undefined && existing.hits <= filter.hits.$gt) {
            return Promise.resolve({ acknowledged: true });
          }
          store.set(filter._id, applyInc(existing, filter._id, update));
          return Promise.resolve({ acknowledged: true });
        },
        deleteOne: (filter: { _id: string }) => {
          store.delete(filter._id);
          return Promise.resolve({ acknowledged: true });
        },
      }),
    });
  },
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

async function makeStore(namespace: string, windowMs = 60_000) {
  const { MongoRateLimitStore } = await import("./rateLimitStore.js");
  const instance = new MongoRateLimitStore(namespace);
  instance.init({ windowMs } as Options);
  return instance;
}

beforeEach(() => {
  store = new Map();
  failWith = null;
  returnNothing = false;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-07T12:00:30.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("counting a window", () => {
  it("counts up from one", async () => {
    const limiter = await makeStore("scoring");

    expect((await limiter.increment("1.2.3.4")).totalHits).toBe(1);
    expect((await limiter.increment("1.2.3.4")).totalHits).toBe(2);
  });

  it("counts each client separately", async () => {
    const limiter = await makeStore("scoring");

    await limiter.increment("1.2.3.4");
    await limiter.increment("1.2.3.4");

    expect((await limiter.increment("5.6.7.8")).totalHits).toBe(1);
  });

  it("reports when the window resets, floored to the interval", async () => {
    // Fixed windows, the same shape as the in-memory store this replaces, so
    // the configured limits keep their existing meaning.
    const limiter = await makeStore("scoring");

    const info = await limiter.increment("1.2.3.4");

    expect(info.resetTime?.toISOString()).toBe("2026-09-07T12:01:00.000Z");
  });

  it("starts a fresh count in the next window", async () => {
    const limiter = await makeStore("scoring");
    await limiter.increment("1.2.3.4");
    await limiter.increment("1.2.3.4");

    vi.setSystemTime(new Date("2026-09-07T12:01:05.000Z"));

    expect((await limiter.increment("1.2.3.4")).totalHits).toBe(1);
  });
});

describe("sharing the count", () => {
  it("continues one window across two store instances", async () => {
    /**
     * The restart and second-instance holes in one test. A separate store
     * object is what a second process looks like from here — it must pick up
     * the existing count rather than issuing a fresh budget.
     */
    const first = await makeStore("scoring");
    await first.increment("1.2.3.4");
    await first.increment("1.2.3.4");

    const second = await makeStore("scoring");

    expect((await second.increment("1.2.3.4")).totalHits).toBe(3);
  });

  it("keeps two limiters' budgets apart", async () => {
    // Sharing a collection must not mean sharing a count: the scoring limiter
    // allows 30/min and diagnostics 120/min, and a shared key would let the
    // tighter one starve the looser.
    const scoring = await makeStore("scoring");
    const diagnostics = await makeStore("diagnostics");

    await scoring.increment("1.2.3.4");
    await scoring.increment("1.2.3.4");

    expect((await diagnostics.increment("1.2.3.4")).totalHits).toBe(1);
  });

  it("outlives the window it is counting, so a sweep cannot cut it short", async () => {
    // Expiry is set two windows past the end, so clock skew between instances
    // cannot expire a window another one is still counting in.
    const limiter = await makeStore("scoring");
    await limiter.increment("1.2.3.4");

    const doc = [...store.values()][0];
    expect(doc?.expiresAt.toISOString()).toBe("2026-09-07T12:03:00.000Z");
  });
});

describe("when the shared store is unreachable", () => {
  it("still enforces a limit, counting in process", async () => {
    /**
     * The point of the fallback. An outage must not open the door — the limit
     * degrades to per-process, which is what shipped before this file existed,
     * rather than disappearing.
     */
    const limiter = await makeStore("scoring");
    failWith = new Error("no connection");

    expect((await limiter.increment("1.2.3.4")).totalHits).toBe(1);
    expect((await limiter.increment("1.2.3.4")).totalHits).toBe(2);
    expect((await limiter.increment("1.2.3.4")).totalHits).toBe(3);
  });

  it("does not throw into the request path", async () => {
    // The store is called on every request through the limiter. An escaping
    // rejection here is a 500 on a healthy endpoint.
    const limiter = await makeStore("scoring");
    failWith = new Error("down");

    await expect(limiter.increment("1.2.3.4")).resolves.toBeDefined();
    await expect(limiter.decrement("1.2.3.4")).resolves.toBeUndefined();
    await expect(limiter.resetKey("1.2.3.4")).resolves.toBeUndefined();
  });

  it("counts locally rather than guessing one hit when the upsert returns nothing", async () => {
    // "One hit" would be the permissive guess, and a permissive guess on every
    // request is no limit at all.
    const limiter = await makeStore("scoring");
    returnNothing = true;

    expect((await limiter.increment("1.2.3.4")).totalHits).toBe(1);
    expect((await limiter.increment("1.2.3.4")).totalHits).toBe(2);
  });

  it("keeps local windows separate per client", async () => {
    const limiter = await makeStore("scoring");
    failWith = new Error("down");

    await limiter.increment("1.2.3.4");
    await limiter.increment("1.2.3.4");

    expect((await limiter.increment("5.6.7.8")).totalHits).toBe(1);
  });

  it("resets the local window when the interval passes", async () => {
    const limiter = await makeStore("scoring");
    failWith = new Error("down");
    await limiter.increment("1.2.3.4");
    await limiter.increment("1.2.3.4");

    vi.setSystemTime(new Date("2026-09-07T12:01:05.000Z"));

    expect((await limiter.increment("1.2.3.4")).totalHits).toBe(1);
  });

  it("recovers the shared count once the store comes back", async () => {
    const limiter = await makeStore("scoring");
    failWith = new Error("down");
    await limiter.increment("1.2.3.4");
    failWith = null;

    // The shared record knows nothing of the locally-counted hit, which is the
    // honest outcome: the shared figure is authoritative and was not written
    // during the outage.
    expect((await limiter.increment("1.2.3.4")).totalHits).toBe(1);
  });
});

describe("the rest of the Store contract", () => {
  it("decrements a hit without going below zero", async () => {
    const limiter = await makeStore("scoring");
    await limiter.increment("1.2.3.4");
    await limiter.increment("1.2.3.4");

    await limiter.decrement("1.2.3.4");

    expect((await limiter.increment("1.2.3.4")).totalHits).toBe(2);
  });

  it("never decrements an absent window into a negative count", async () => {
    // A negative count would grant free requests in the next window.
    const limiter = await makeStore("scoring");

    await limiter.decrement("9.9.9.9");

    expect((await limiter.increment("9.9.9.9")).totalHits).toBe(1);
  });

  it("clears a key on reset", async () => {
    const limiter = await makeStore("scoring");
    await limiter.increment("1.2.3.4");
    await limiter.increment("1.2.3.4");

    await limiter.resetKey("1.2.3.4");

    expect((await limiter.increment("1.2.3.4")).totalHits).toBe(1);
  });

  it("tells express-rate-limit the keys are not process-local", async () => {
    // The library uses this to decide whether it may trust its own
    // bookkeeping. Claiming local keys would defeat the whole point.
    const limiter = await makeStore("scoring");

    expect(limiter.localKeys).toBe(false);
  });
});
