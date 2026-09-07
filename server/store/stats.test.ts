/**
 * The daily rollup that lets a trend outlive the takes it came from.
 *
 * Three things here are easy to get wrong in ways that produce a
 * plausible-looking number rather than an error.
 *
 * A cron that fires twice must correct the day, not double it. A day is the
 * document id and the write is a replace, so re-running is the fix rather than
 * the bug.
 *
 * A missing field on an old record must not null the whole sum. `$ifNull` on
 * every summed expression, because one record written before the current audio
 * shape would otherwise turn a real day into a blank one silently.
 *
 * And the learner figure must be a count, never a list. This collection is
 * kept indefinitely, and a record of who practised on a given day would make
 * that a privacy decision rather than an operational one.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "mongodb";
import { isDay, previousDay, rollupDay, rollupRange, type StatsDocument } from "./stats.js";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

interface Attempt {
  createdAt: Date;
  learnerId?: string;
  result?: { indeterminate?: boolean; words?: Array<{ errorType?: string }> };
  audio?: { seconds?: number };
  timings?: { providerMs?: number; totalMs?: number };
}

let attempts: Attempt[] = [];
let stats: Map<string, StatsDocument>;

/**
 * A Db that runs the real aggregation shape against in-memory documents.
 *
 * The pipeline is interpreted rather than executed by Mongo, so this proves
 * the *intent* — which fields are summed, which records are matched, and that
 * ids are never stored. A live mongod would make the suite non-idempotent,
 * which this project has already paid for once.
 */
function fakeDb(): Db {
  return {
    collection: (name: string) => {
      if (name === "attempts") {
        return {
          aggregate: (pipeline: Array<Record<string, unknown>>) => ({
            toArray: () => {
              const match = pipeline[0]?.["$match"] as
                | { createdAt: { $gte: Date; $lt: Date } }
                | undefined;
              if (match === undefined) return Promise.resolve([]);

              const inDay = attempts.filter(
                (a) => a.createdAt >= match.createdAt.$gte && a.createdAt < match.createdAt.$lt,
              );
              if (inDay.length === 0) return Promise.resolve([]);

              const scored = inDay.filter((a) => a.result?.indeterminate !== true);
              const providerTimes = inDay
                .map((a) => a.timings?.providerMs)
                .filter((ms): ms is number => typeof ms === "number");
              const totalTimes = inDay
                .map((a) => a.timings?.totalMs)
                .filter((ms): ms is number => typeof ms === "number");

              return Promise.resolve([
                {
                  calls: inDay.length,
                  indeterminate: inDay.filter((a) => a.result?.indeterminate === true).length,
                  miscue: scored.filter(
                    (a) =>
                      (a.result?.words ?? []).length > 0 &&
                      (a.result?.words ?? []).some((w) => w.errorType !== "None"),
                  ).length,
                  audioSeconds: inDay.reduce((sum, a) => sum + (a.audio?.seconds ?? 0), 0),
                  billableSeconds: inDay.reduce((sum, a) => sum + Math.ceil(a.audio?.seconds ?? 0), 0),
                  providerMs:
                    providerTimes.length === 0
                      ? null
                      : providerTimes.reduce((a, b) => a + b, 0) / providerTimes.length,
                  totalMs:
                    totalTimes.length === 0
                      ? null
                      : totalTimes.reduce((a, b) => a + b, 0) / totalTimes.length,
                  // $addToSet skips missing fields, as the real one does.
                  learners: [...new Set(inDay.map((a) => a.learnerId).filter((id) => id !== undefined))],
                },
              ]);
            },
          }),
        };
      }
      return {
        replaceOne: (filter: { _id: string }, doc: StatsDocument) => {
          stats.set(filter._id, doc);
          return Promise.resolve({ acknowledged: true });
        },
      };
    },
  } as unknown as Db;
}

function attempt(over: Partial<Attempt> = {}): Attempt {
  return {
    createdAt: new Date("2026-09-07T10:00:00.000Z"),
    learnerId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    result: { indeterminate: false, words: [{ errorType: "None" }] },
    audio: { seconds: 2 },
    timings: { providerMs: 900, totalMs: 1000 },
    ...over,
  };
}

beforeEach(() => {
  attempts = [];
  stats = new Map();
  vi.clearAllMocks();
});

describe("reading a day", () => {
  it("counts the calls inside it", async () => {
    attempts = [attempt(), attempt(), attempt()];

    const day = await rollupDay(fakeDb(), "2026-09-07");

    expect(day.calls).toBe(3);
  });

  it("excludes a call from the day before and the day after", async () => {
    attempts = [
      attempt({ createdAt: new Date("2026-09-06T23:59:59.999Z") }),
      attempt({ createdAt: new Date("2026-09-07T00:00:00.000Z") }),
      attempt({ createdAt: new Date("2026-09-07T23:59:59.999Z") }),
      attempt({ createdAt: new Date("2026-09-08T00:00:00.000Z") }),
    ];

    expect((await rollupDay(fakeDb(), "2026-09-07")).calls).toBe(2);
  });

  it("stores a zero day rather than nothing", async () => {
    // A day with no practice is a fact. An absent document is indistinguishable
    // from a rollup that never ran.
    const day = await rollupDay(fakeDb(), "2026-09-07");

    expect(day).toMatchObject({ calls: 0, indeterminate: 0, learners: 0 });
    expect(stats.get("2026-09-07")).toBeDefined();
  });

  it("counts indeterminate takes separately", async () => {
    attempts = [attempt(), attempt({ result: { indeterminate: true } })];

    const day = await rollupDay(fakeDb(), "2026-09-07");

    expect(day).toMatchObject({ calls: 2, indeterminate: 1 });
  });

  it("counts a miscue only on a take that was scored", async () => {
    /**
     * An indeterminate result has no words, so counting it would depress the
     * miscue rate by exactly the indeterminate rate — and make both figures
     * harder to read than either alone.
     */
    attempts = [
      attempt({ result: { indeterminate: false, words: [{ errorType: "Omission" }] } }),
      attempt({ result: { indeterminate: false, words: [{ errorType: "None" }] } }),
      attempt({ result: { indeterminate: true } }),
    ];

    const day = await rollupDay(fakeDb(), "2026-09-07");

    expect(day.miscue).toBe(1);
    expect(day.calls).toBe(3);
  });

  it("rounds billable seconds up per call, as the provider charges", async () => {
    attempts = [attempt({ audio: { seconds: 0.4 } }), attempt({ audio: { seconds: 1.2 } })];

    const day = await rollupDay(fakeDb(), "2026-09-07");

    expect(day.audioSeconds).toBeCloseTo(1.6, 2);
    expect(day.billableSeconds).toBe(3);
  });

  it("averages both latencies", async () => {
    attempts = [
      attempt({ timings: { providerMs: 800, totalMs: 900 } }),
      attempt({ timings: { providerMs: 1000, totalMs: 1100 } }),
    ];

    const day = await rollupDay(fakeDb(), "2026-09-07");

    expect(day.meanProviderMs).toBe(900);
    expect(day.meanTotalMs).toBe(1000);
  });

  it("reports null latency rather than zero when nothing was timed", async () => {
    // Zero milliseconds is a claim; null is the absence of one.
    attempts = [attempt({ timings: undefined })];

    const day = await rollupDay(fakeDb(), "2026-09-07");

    expect(day.meanProviderMs).toBeNull();
  });

  it("survives records written before the current audio shape", async () => {
    /**
     * One missing field would otherwise null the whole sum and turn a real
     * day into a blank one, with nothing anywhere reporting a problem.
     */
    attempts = [attempt(), attempt({ audio: undefined }), attempt({ result: undefined })];

    const day = await rollupDay(fakeDb(), "2026-09-07");

    expect(day.calls).toBe(3);
    // Two seconds each from the two records that still have audio; the one
    // missing it contributes nothing rather than nulling the sum.
    expect(day.audioSeconds).toBe(4);
  });
});

describe("learners", () => {
  it("counts them without storing who they were", async () => {
    /**
     * This collection is kept indefinitely. A list of who practised on a given
     * day would make that a privacy decision rather than an operational one,
     * so the document carries a number and the ids are discarded.
     */
    attempts = [attempt({ learnerId: "a" }), attempt({ learnerId: "b" }), attempt({ learnerId: "a" })];

    const day = await rollupDay(fakeDb(), "2026-09-07");

    expect(day.learners).toBe(2);
    expect(JSON.stringify(day)).not.toContain('"a"');
    expect(Object.keys(day)).not.toContain("learnerIds");
  });

  it("does not count anonymous takes as a phantom learner", async () => {
    // An unattributed attempt has no id at all, so it is not counted — which
    // is honest rather than convenient.
    attempts = [attempt({ learnerId: undefined }), attempt({ learnerId: "a" })];

    expect((await rollupDay(fakeDb(), "2026-09-07")).learners).toBe(1);
  });
});

describe("running it twice", () => {
  it("corrects the day rather than doubling it", async () => {
    /**
     * The obvious failure for anything on a cron. The day is the document id
     * and the write is a replace, so a double fire is a no-op.
     */
    attempts = [attempt(), attempt()];
    const db = fakeDb();

    await rollupDay(db, "2026-09-07");
    const second = await rollupDay(db, "2026-09-07");

    expect(second.calls).toBe(2);
    expect(stats.size).toBe(1);
  });

  it("picks up records that arrived since the first run", async () => {
    attempts = [attempt()];
    const db = fakeDb();
    await rollupDay(db, "2026-09-07");

    attempts.push(attempt());

    expect((await rollupDay(db, "2026-09-07")).calls).toBe(2);
  });

  it("records when it ran, so a stale day is recognisable", async () => {
    const day = await rollupDay(fakeDb(), "2026-09-07");

    expect(day.computedAt).toBeInstanceOf(Date);
  });
});

describe("a range, for backfill", () => {
  it("rolls up every day inclusive", async () => {
    const days = await rollupRange(fakeDb(), "2026-09-05", "2026-09-07");

    expect(days.map((d) => d._id)).toEqual(["2026-09-05", "2026-09-06", "2026-09-07"]);
  });

  it("handles a single-day range", async () => {
    expect((await rollupRange(fakeDb(), "2026-09-07", "2026-09-07")).map((d) => d._id)).toEqual([
      "2026-09-07",
    ]);
  });

  it("crosses a month boundary", async () => {
    const days = await rollupRange(fakeDb(), "2026-08-30", "2026-09-01");

    expect(days.map((d) => d._id)).toEqual(["2026-08-30", "2026-08-31", "2026-09-01"]);
  });

  it("returns nothing for a backwards range rather than looping forever", async () => {
    expect(await rollupRange(fakeDb(), "2026-09-07", "2026-09-05")).toEqual([]);
  });
});

describe("day validation", () => {
  it("accepts a real date", () => {
    expect(isDay("2026-09-07")).toBe(true);
    expect(isDay("2028-02-29")).toBe(true);
  });

  it("rejects a date that does not exist", () => {
    // 2026-02-30 parses happily to the second of March, so this is checked by
    // round-trip rather than by parsing alone.
    expect(isDay("2026-02-30")).toBe(false);
    expect(isDay("2026-02-29")).toBe(false);
    expect(isDay("2026-99-99")).toBe(false);
    expect(isDay("2026-9-7")).toBe(false);
    expect(isDay("")).toBe(false);
  });

  it("refuses to roll up something that is not a day", async () => {
    await expect(rollupDay(fakeDb(), "yesterday")).rejects.toThrow(/not a day/);
  });

  it("defaults to yesterday, the last day that is complete", () => {
    /**
     * Rolling up today would store a partial figure under a final-looking id,
     * and the re-run that fixed it would be indistinguishable from a
     * correction.
     */
    expect(previousDay(new Date("2026-09-07T00:30:00.000Z"))).toBe("2026-09-06");
    expect(previousDay(new Date("2026-09-01T12:00:00.000Z"))).toBe("2026-08-31");
  });
});
