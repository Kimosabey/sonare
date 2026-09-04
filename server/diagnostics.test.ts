/**
 * The error trail, and a promise that has to hold when everything else fails.
 *
 * Client and server capture failures used to surface as a local toast and were
 * never seen again — which meant nobody could tell whether UNCLEAR was one
 * learner's room or a scorer problem. Persisting them is how a rate becomes a
 * finding.
 *
 * The contract is that this never fails a learner's request. That is easy to
 * write and easy to lose: the interesting cases are Mongo being down, the
 * fallback *also* being broken, and a record that cannot be serialized at all.
 * Every one of those must end with the learner getting their score.
 *
 * Its sibling attempts.ts learned this the hard way — its own promise was true
 * only by another module's discipline, until a test broke appendFallback on
 * purpose.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const insertOne = vi.fn(() => Promise.resolve({ acknowledged: true }));
const toArray = vi.fn(() => Promise.resolve([{ code: "SNR_TOO_LOW" }]));
const appendFallback = vi.fn(() => Promise.resolve());
const limit = vi.fn(() => ({ toArray }));
const sort = vi.fn(() => ({ limit }));
const find = vi.fn(() => ({ sort }));

let getDbFails = false;

vi.mock("./db.js", () => ({
  getDb: () => {
    if (getDbFails) return Promise.reject(new Error("no mongo"));
    return Promise.resolve({ collection: () => ({ insertOne, find }) });
  },
}));
vi.mock("./fallbackLog.js", () => ({
  appendFallback: (...args: unknown[]) => appendFallback(...(args as [])),
}));
vi.mock("./logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const record = {
  at: "2026-09-04T10:00:00Z",
  source: "client" as const,
  code: "SNR_TOO_LOW",
  domain: "client",
  message: "background noise too high",
};

beforeEach(() => {
  vi.clearAllMocks();
  getDbFails = false;
  insertOne.mockResolvedValue({ acknowledged: true });
  appendFallback.mockResolvedValue(undefined);
  toArray.mockResolvedValue([{ code: "SNR_TOO_LOW" }]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recordDiagnostic — the normal path", () => {
  it("persists the record", async () => {
    const { recordDiagnostic } = await import("./diagnostics.js");

    await recordDiagnostic(record);

    expect(insertOne).toHaveBeenCalledTimes(1);
    expect(appendFallback).not.toHaveBeenCalled();
  });

  it("stamps createdAt, which is what the TTL index expires on", async () => {
    /**
     * `at` is the client's clock and cannot be trusted for retention — a
     * device with a wrong date would either expire immediately or never. The
     * server's own timestamp is what the retention window is built on, so its
     * absence would quietly mean nothing ever expires.
     */
    const { recordDiagnostic } = await import("./diagnostics.js");

    await recordDiagnostic(record);

    const [doc] = insertOne.mock.calls[0] as unknown as [{ createdAt: Date; at: string }];
    expect(doc.createdAt).toBeInstanceOf(Date);
    expect(doc.at).toBe("2026-09-04T10:00:00Z");
  });

  it("keeps the correlation fields that make a funnel readable", async () => {
    // sessionId ties every attempt and diagnostic in one session together;
    // without it a failure cannot be placed against the take that caused it.
    const { recordDiagnostic } = await import("./diagnostics.js");

    await recordDiagnostic({ ...record, sessionId: "s-1", activityId: 4, learnerName: "speaker-a" });

    const [doc] = insertOne.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(doc.sessionId).toBe("s-1");
    expect(doc.activityId).toBe(4);
    expect(doc.learnerName).toBe("speaker-a");
  });
});

describe("recordDiagnostic — never failing a learner's request", () => {
  it("falls back to disk when Mongo is unreachable", async () => {
    /**
     * The first fallback write of a deployment's life happens during an
     * outage, which is also when the records matter most: a diagnostic lost
     * during an incident is the one that would have explained it.
     */
    getDbFails = true;
    const { recordDiagnostic } = await import("./diagnostics.js");

    await expect(recordDiagnostic(record)).resolves.toBeUndefined();

    expect(appendFallback).toHaveBeenCalledWith("diagnostics", record);
  });

  it("falls back when the insert itself fails", async () => {
    // A connected Mongo can still refuse a write — a full disk, a failed
    // primary election.
    insertOne.mockRejectedValue(new Error("not primary"));
    const { recordDiagnostic } = await import("./diagnostics.js");

    await recordDiagnostic(record);

    expect(appendFallback).toHaveBeenCalledTimes(1);
  });

  it("resolves even when the fallback is broken too", async () => {
    /**
     * The case that makes the promise true by construction rather than by
     * coincidence. appendFallback swallows its own failures — but relying on
     * that means one bug over there lets a rejection escape from here, and
     * this function's whole contract is that it cannot. Its sibling
     * attempts.ts had exactly that bug.
     */
    getDbFails = true;
    appendFallback.mockRejectedValue(new Error("disk full"));
    const { recordDiagnostic } = await import("./diagnostics.js");

    await expect(recordDiagnostic(record)).resolves.toBeUndefined();
  });

  it("resolves when the fallback throws synchronously", async () => {
    // A `.catch()` handles a rejected promise, not a synchronous throw. Both
    // have to be survivable, because the caller is a learner's request.
    getDbFails = true;
    appendFallback.mockImplementation(() => {
      throw new Error("synchronous");
    });
    const { recordDiagnostic } = await import("./diagnostics.js");

    await expect(recordDiagnostic(record)).resolves.toBeUndefined();
  });

  it("survives a record that cannot be serialized", async () => {
    // `context` is whatever the client sent, and a circular structure would
    // make a stringify throw somewhere down the chain.
    getDbFails = true;
    const circular: Record<string, unknown> = { ...record };
    circular.self = circular;
    const { recordDiagnostic } = await import("./diagnostics.js");

    await expect(
      recordDiagnostic(circular as unknown as Parameters<typeof recordDiagnostic>[0]),
    ).resolves.toBeUndefined();
  });

  it("does not write to disk when Mongo worked", async () => {
    // Two copies of every record would double the retention surface and make
    // the replay script re-insert everything it drains.
    const { recordDiagnostic } = await import("./diagnostics.js");

    await recordDiagnostic(record);

    expect(appendFallback).not.toHaveBeenCalled();
  });
});

describe("listDiagnostics", () => {
  it("returns the most recent first, which is the only useful order here", async () => {
    // The screen exists to answer "what is going wrong right now".
    const { listDiagnostics } = await import("./diagnostics.js");

    await listDiagnostics(50);

    expect(sort).toHaveBeenCalledWith({ at: -1 });
  });

  it("applies the caller's limit", async () => {
    // The route caps this; the module must not quietly ignore it, or one
    // request would pull the whole collection.
    const { listDiagnostics } = await import("./diagnostics.js");

    await listDiagnostics(25);

    expect(limit).toHaveBeenCalledWith(25);
  });

  it("propagates a read failure instead of returning an empty list", async () => {
    /**
     * The opposite stance from the write path, deliberately. A silent empty
     * list on the diagnostics screen reads as "no errors", which is the most
     * misleading thing this screen could say — an operator would conclude the
     * system is healthy. A failed read has to fail.
     */
    getDbFails = true;
    const { listDiagnostics } = await import("./diagnostics.js");

    await expect(listDiagnostics(50)).rejects.toThrow();
  });
});
