/**
 * The link that makes the fallback reachable.
 *
 * fallbackLog.test.ts proves the file survives a crash and replays cleanly.
 * That is worth nothing if a Mongo failure never reaches it — and the reason
 * it might not is that this module deliberately swallows its own errors, so a
 * broken route to the fallback would look exactly like a working one from
 * outside.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttemptRecord } from "./attempts.js";

const insertOne = vi.fn(() => Promise.resolve());
let dbBehaviour: () => Promise<unknown> = () =>
  Promise.resolve({ collection: () => ({ insertOne }) });

vi.mock("./db.js", () => ({ getDb: () => dbBehaviour() }));

const appendFallback = vi.fn(() => Promise.resolve());
vi.mock("./fallbackLog.js", () => ({
  appendFallback: (...args: unknown[]) => appendFallback(...(args as [])),
}));

const RECORD: AttemptRecord = {
  at: "2026-09-04T10:00:00Z",
  referenceText: "Bonjour, comment allez-vous",
  language: "fr-FR",
  provider: "azure",
  deviceContext: { ua: "test" },
  audio: { bytes: 32000, seconds: 1, sampleRate: 16000, channels: 1, bitsPerSample: 16 },
  timings: { providerMs: 1370, totalMs: 1372 },
  result: { indeterminate: true, provider: "azure", reason: "no speech found to assess" },
};

beforeEach(() => {
  vi.clearAllMocks();
  insertOne.mockResolvedValue(undefined);
  dbBehaviour = () => Promise.resolve({ collection: () => ({ insertOne }) });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recordAttempt", () => {
  it("writes to Mongo and does not touch the fallback when that works", async () => {
    const { recordAttempt } = await import("./attempts.js");

    await recordAttempt(RECORD);

    expect(insertOne).toHaveBeenCalledTimes(1);
    expect(appendFallback).not.toHaveBeenCalled();
  });

  it("adds a real Date alongside the display string, for the TTL index", async () => {
    // Mongo can only expire documents on a BSON Date, and `at` is a formatted
    // string. Without `createdAt` the retention index silently expires nothing
    // and the 90-day policy is a comment rather than a behaviour.
    const { recordAttempt } = await import("./attempts.js");

    await recordAttempt(RECORD);

    const [doc] = insertOne.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(doc.createdAt).toBeInstanceOf(Date);
    expect(doc.at).toBe("2026-09-04T10:00:00Z");
  });

  it("falls back to the file when Mongo is unreachable", async () => {
    // The case the fallback exists for. PRD §8 makes this trail the
    // deliverable, so a dropped record can invalidate the measurement.
    dbBehaviour = () => Promise.reject(new Error("ECONNREFUSED"));
    const { recordAttempt } = await import("./attempts.js");

    await recordAttempt(RECORD);

    expect(appendFallback).toHaveBeenCalledTimes(1);
    const [collection, record] = appendFallback.mock.calls[0] as unknown as [string, AttemptRecord];
    expect(collection).toBe("attempts");
    expect(record.referenceText).toBe("Bonjour, comment allez-vous");
  });

  it("falls back when the insert itself fails, not only the connection", async () => {
    // A reachable Mongo that refuses the write — disk full, auth expired — is
    // just as much a lost record as an unreachable one.
    insertOne.mockRejectedValue(new Error("not authorized"));
    const { recordAttempt } = await import("./attempts.js");

    await recordAttempt(RECORD);

    expect(appendFallback).toHaveBeenCalledTimes(1);
  });

  it("hands the fallback the record without the TTL field it added", async () => {
    // Replay re-inserts these, and attempts.ts adds createdAt on the way in.
    // Writing it to the file too would replay a stale creation date and expire
    // the record early.
    dbBehaviour = () => Promise.reject(new Error("down"));
    const { recordAttempt } = await import("./attempts.js");

    await recordAttempt(RECORD);

    const [, record] = appendFallback.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(record.createdAt).toBeUndefined();
  });

  it("never throws into a learner's request", async () => {
    // Both layers broken. The learner still gets their score; only the
    // analysis record is lost, which is the correct thing to sacrifice.
    dbBehaviour = () => Promise.reject(new Error("down"));
    appendFallback.mockRejectedValue(new Error("disk full"));
    const { recordAttempt } = await import("./attempts.js");

    await expect(recordAttempt(RECORD)).resolves.toBeUndefined();
  });
});
