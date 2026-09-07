/**
 * The ceiling that has to survive a restart.
 *
 * The cap in services/index.ts counts in process memory, so today a restart
 * loop hands out a fresh allowance of paid calls each time and a second
 * instance doubles the ceiling. These tests pin the two properties that make a
 * shared counter an actual ceiling: it cannot be exceeded by concurrent
 * requests, and it **refuses** rather than allows when the store is
 * unreachable.
 *
 * `getDb` is mocked with a small in-memory stand-in that reproduces the two
 * Mongo behaviours the design depends on: a conditional `findOneAndUpdate`
 * with `upsert`, and the duplicate-key collision that happens when the filter
 * matches nothing but the `_id` already exists.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Doc {
  _id: string;
  day: string;
  calls: number;
  audioSeconds: number;
  billableSeconds: number;
  indeterminateCalls: number;
  indeterminateSeconds: number;
  expiresAt: Date;
}

let store: Map<string, Doc>;
let failWith: Error | null = null;
let indexes: Array<{ keys: unknown; options: unknown }>;

/** Applies a $inc/$setOnInsert update the way Mongo would. */
function applyUpdate(existing: Doc | undefined, id: string, update: Record<string, Record<string, unknown>>): Doc {
  const inc = update["$inc"] ?? {};
  const onInsert = update["$setOnInsert"] ?? {};
  const base: Record<string, unknown> = existing
    ? { ...existing }
    : { _id: id, calls: 0, audioSeconds: 0, billableSeconds: 0, indeterminateCalls: 0, indeterminateSeconds: 0, ...onInsert };
  for (const [k, v] of Object.entries(inc)) {
    base[k] = ((base[k] as number) ?? 0) + (v as number);
  }
  return base as unknown as Doc;
}

function duplicateKeyError(): Error & { code: number } {
  const err = new Error("E11000 duplicate key error") as Error & { code: number };
  err.code = 11000;
  return err;
}

vi.mock("./db.js", () => ({
  getDb: () => {
    if (failWith) return Promise.reject(failWith);
    return Promise.resolve({
      collection: () => ({
        createIndex: (keys: unknown, options: unknown) => {
          indexes.push({ keys, options });
          return Promise.resolve("ok");
        },
        findOne: (filter: { _id: string }) => Promise.resolve(store.get(filter._id) ?? null),
        findOneAndUpdate: (
          filter: { _id: string; calls?: { $lt: number } },
          update: Record<string, Record<string, unknown>>,
          options: { upsert?: boolean },
        ) => {
          const existing = store.get(filter._id);
          const capOk = filter.calls === undefined || (existing?.calls ?? 0) < filter.calls.$lt;

          if (existing !== undefined && !capOk) {
            // Filter matched nothing and _id is taken — exactly the collision
            // the real driver raises on an upsert in this situation.
            if (options.upsert === true) return Promise.reject(duplicateKeyError());
            return Promise.resolve(null);
          }
          if (existing === undefined && !capOk && options.upsert !== true) {
            return Promise.resolve(null);
          }

          const next = applyUpdate(existing, filter._id, update);
          store.set(filter._id, next);
          return Promise.resolve(next);
        },
        updateOne: (
          filter: { _id: string },
          update: Record<string, Record<string, unknown>>,
          _options: { upsert?: boolean },
        ) => {
          const next = applyUpdate(store.get(filter._id), filter._id, update);
          store.set(filter._id, next);
          return Promise.resolve({ acknowledged: true });
        },
      }),
    });
  },
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const AT = new Date("2026-09-07T13:00:00.000Z");

async function load() {
  vi.resetModules();
  return import("./counters.js");
}

beforeEach(() => {
  store = new Map();
  indexes = [];
  failWith = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the UTC day key", () => {
  it("keys on the provider's calendar, not the learner's", async () => {
    /**
     * Azure bills in UTC, so the ceiling is a UTC day. The streak's local day
     * is the separate and equally deliberate choice — a streak is a claim
     * about the learner's calendar. Neither should be "fixed" to match.
     */
    const { utcDay } = await load();

    expect(utcDay(new Date("2026-09-07T23:59:59.000Z"))).toBe("2026-09-07");
    expect(utcDay(new Date("2026-09-08T00:00:00.000Z"))).toBe("2026-09-08");
  });

  it("pads single-digit months and days", async () => {
    const { utcDay } = await load();

    expect(utcDay(new Date("2026-01-05T12:00:00.000Z"))).toBe("2026-01-05");
  });

  it("rolls the counter at midnight UTC", async () => {
    const { reserveScoringCall } = await load();

    await reserveScoringCall(10, new Date("2026-09-07T23:59:00.000Z"));
    const next = await reserveScoringCall(10, new Date("2026-09-08T00:01:00.000Z"));

    // A fresh day starts at one, not two.
    expect(next).toEqual({ allowed: true, calls: 1 });
  });
});

describe("claiming a call", () => {
  it("allows the first call and counts it", async () => {
    const { reserveScoringCall } = await load();

    expect(await reserveScoringCall(3, AT)).toEqual({ allowed: true, calls: 1 });
  });

  it("counts up to the cap and then refuses", async () => {
    const { reserveScoringCall } = await load();

    expect((await reserveScoringCall(3, AT)).calls).toBe(1);
    expect((await reserveScoringCall(3, AT)).calls).toBe(2);
    expect((await reserveScoringCall(3, AT)).calls).toBe(3);

    expect(await reserveScoringCall(3, AT)).toEqual({ allowed: false, reason: "at-cap", calls: 3 });
  });

  it("cannot be exceeded by concurrent requests", async () => {
    /**
     * The reason this is increment-and-check rather than check-then-increment.
     * Under the second, two requests both read `cap - 1` and both proceed, and
     * the cap is exceeded by however many arrive at once.
     */
    const { reserveScoringCall } = await load();

    const results = await Promise.all(
      Array.from({ length: 20 }, () => reserveScoringCall(5, AT)),
    );

    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(store.get("spend:2026-09-07")?.calls).toBe(5);
  });

  it("does not keep inflating the count once refused", async () => {
    // The count is a billing figure. Refused calls cost nothing and must not
    // appear in it.
    const { reserveScoringCall } = await load();

    await reserveScoringCall(1, AT);
    await reserveScoringCall(1, AT);
    await reserveScoringCall(1, AT);

    expect(store.get("spend:2026-09-07")?.calls).toBe(1);
  });

  it("refuses everything when the cap is zero", async () => {
    // Matching the existing `count >= cap` behaviour, and guarded before the
    // query — an upsert against a filter nothing can satisfy would otherwise
    // insert a first call and allow it.
    const { reserveScoringCall } = await load();

    expect(await reserveScoringCall(0, AT)).toEqual({ allowed: false, reason: "at-cap", calls: 0 });
    expect(store.size).toBe(0);
  });

  it("refuses on a cap that is not a real number", async () => {
    // env.ts should never hand this over, but a ceiling that vanishes on NaN
    // is the exact bug numberFromEnv exists to prevent, so it is refused here
    // too rather than trusted one layer up.
    const { reserveScoringCall } = await load();

    expect((await reserveScoringCall(Number.NaN, AT)).allowed).toBe(false);
    expect((await reserveScoringCall(Number.POSITIVE_INFINITY, AT)).allowed).toBe(false);
  });
});

describe("when the store is unreachable", () => {
  it("refuses the call rather than allowing it", async () => {
    /**
     * The whole point. A ceiling that disappears when the system is unhealthy
     * is not a ceiling — and this is the same choice env.ts makes for numeric
     * config. Being wrong this way costs a learner a "try again shortly";
     * being wrong the other way costs an unbounded bill.
     */
    const { reserveScoringCall } = await load();
    failWith = new Error("no connection");

    expect(await reserveScoringCall(2000, AT)).toEqual({
      allowed: false,
      reason: "unavailable",
      calls: null,
    });
  });

  it("distinguishes unavailable from at-cap, so the learner is told the truth", async () => {
    // "Try again tomorrow" and "try again shortly" are different messages, and
    // the type carries no count in the unavailable case so a caller cannot
    // report a figure it does not have.
    const { reserveScoringCall } = await load();

    await reserveScoringCall(1, AT);
    const atCap = await reserveScoringCall(1, AT);
    failWith = new Error("down");
    const unavailable = await reserveScoringCall(1, AT);

    expect(atCap.allowed).toBe(false);
    expect(unavailable.allowed).toBe(false);
    expect(atCap.allowed === false && atCap.reason).toBe("at-cap");
    expect(unavailable.allowed === false && unavailable.reason).toBe("unavailable");
  });

  it("reads as no counter rather than throwing", async () => {
    const { readCounter } = await load();
    failWith = new Error("down");

    await expect(readCounter(AT)).resolves.toBeNull();
  });
});

describe("recording what a call consumed", () => {
  it("rounds billable seconds up per call, as the provider does", async () => {
    /**
     * Summing raw durations understates the bill, worst on the short clips
     * this product is mostly made of: 80 sub-second words send roughly 44
     * seconds and are billed 80.
     */
    const { recordCallOutcome } = await load();

    await recordCallOutcome({ seconds: 0.4, indeterminate: false }, AT);
    await recordCallOutcome({ seconds: 1.2, indeterminate: false }, AT);

    const doc = store.get("spend:2026-09-07");
    expect(doc?.billableSeconds).toBe(3);
    expect(doc?.audioSeconds).toBeCloseTo(1.6, 5);
  });

  it("counts an indeterminate call as billed, because it is", async () => {
    // R8 makes indeterminate the honest answer, but the provider still charged
    // for it. Spend that bought no learner feedback is the figure worth
    // watching, so it is tracked separately rather than excluded.
    const { recordCallOutcome } = await load();

    await recordCallOutcome({ seconds: 2, indeterminate: true }, AT);

    const doc = store.get("spend:2026-09-07");
    expect(doc?.indeterminateCalls).toBe(1);
    expect(doc?.indeterminateSeconds).toBe(2);
    expect(doc?.billableSeconds).toBe(2);
  });

  it("ignores a duration that is negative or not a number", async () => {
    const { recordCallOutcome } = await load();

    await recordCallOutcome({ seconds: -5, indeterminate: false }, AT);
    await recordCallOutcome({ seconds: Number.NaN, indeterminate: false }, AT);

    const doc = store.get("spend:2026-09-07");
    expect(doc?.audioSeconds).toBe(0);
    expect(doc?.billableSeconds).toBe(0);
  });

  it("never throws, because the learner already has their score", async () => {
    const { recordCallOutcome } = await load();
    failWith = new Error("down");

    await expect(recordCallOutcome({ seconds: 1, indeterminate: false }, AT)).resolves.toBeUndefined();
  });

  it("does not let accounting create a call allowance", async () => {
    // recordCallOutcome upserts, so it can create the document. It must seed
    // `calls` at zero — a counter conjured by accounting must not read as a
    // call already spent, nor as room that was never reserved.
    const { recordCallOutcome, reserveScoringCall } = await load();

    await recordCallOutcome({ seconds: 1, indeterminate: false }, AT);
    expect(store.get("spend:2026-09-07")?.calls).toBe(0);

    expect(await reserveScoringCall(1, AT)).toEqual({ allowed: true, calls: 1 });
    expect((await reserveScoringCall(1, AT)).allowed).toBe(false);
  });
});

describe("retention", () => {
  it("expires a day's counter on its own horizon", async () => {
    // 32 days by default: enough for a billing question, and short enough that
    // a collection of counts never becomes a retention concern of its own.
    const { reserveScoringCall } = await load();

    await reserveScoringCall(10, AT);

    const expiresAt = store.get("spend:2026-09-07")?.expiresAt;
    expect(expiresAt).toBeInstanceOf(Date);
    expect(expiresAt?.toISOString()).toBe("2026-10-09T00:00:00.000Z");
  });
});
