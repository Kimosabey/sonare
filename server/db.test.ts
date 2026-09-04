/**
 * The connection, and the retention window that is a privacy posture rather
 * than an optimisation.
 *
 * Both collections hold learner voice *metadata* — the phrase they were asked
 * to say, their self-reported name, their device, their scores, tied together
 * by session. That is personal data, and the TTL index on `createdAt` is the
 * entire mechanism by which it stops existing. A missing TTL index is not a
 * slow query: it is indefinite retention that nobody chose and nothing
 * reports.
 *
 * The failure modes are all silent. Index creation is deliberately
 * non-fatal — a missing index must never take startup down — which means the
 * only way to know the retention index exists is to assert it. And the cached
 * promise has to be cleared on failure, or one unlucky connection at boot
 * makes every later request replay the same rejection forever.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface IndexCall {
  collection: string;
  keys: Record<string, number>;
  options?: { expireAfterSeconds?: number };
}

let indexCalls: IndexCall[] = [];
let connectBehaviour: () => Promise<void> = () => Promise.resolve();
let createIndexFails = false;
let connectCount = 0;

vi.mock("mongodb", () => ({
  MongoClient: class {
    constructor(public url: string) {}
    connect() {
      connectCount += 1;
      return connectBehaviour();
    }
    db(name: string) {
      return {
        databaseName: name,
        collection: (collection: string) => ({
          createIndex: (keys: Record<string, number>, options?: { expireAfterSeconds?: number }) => {
            indexCalls.push({ collection, keys, ...(options ? { options } : {}) });
            return createIndexFails
              ? Promise.reject(new Error("index conflict"))
              : Promise.resolve("ok");
          },
        }),
      };
    }
  },
}));
vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const SAVED = {
  url: process.env.MONGO_URL,
  name: process.env.MONGO_DB,
  retention: process.env.RETENTION_DAYS,
};

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function load(env: Record<string, string | undefined> = {}) {
  for (const [k, v] of Object.entries(env)) restore(k, v);
  vi.resetModules();
  return import("./db.js");
}

function ttlFor(collection: string): IndexCall | undefined {
  return indexCalls.find((c) => c.collection === collection && c.options?.expireAfterSeconds !== undefined);
}

beforeEach(() => {
  indexCalls = [];
  connectCount = 0;
  createIndexFails = false;
  connectBehaviour = () => Promise.resolve();
});

afterEach(() => {
  restore("MONGO_URL", SAVED.url);
  restore("MONGO_DB", SAVED.name);
  restore("RETENTION_DAYS", SAVED.retention);
});

describe("the retention window", () => {
  it("puts a TTL index on both collections holding learner data", async () => {
    /**
     * Not one or the other. `attempts` carries the phrase and the score;
     * `diagnostics` carries the error trail with the same sessionId and
     * learner name attached. Expiring one and keeping the other would leave a
     * per-learner record of every failed take, indefinitely.
     */
    const { getDb } = await load({ RETENTION_DAYS: "90" });

    await getDb();

    expect(ttlFor("attempts")).toBeDefined();
    expect(ttlFor("diagnostics")).toBeDefined();
  });

  it("expires on the server's own timestamp, not the client's", async () => {
    /**
     * `createdAt` is stamped server-side; `at` is the client's clock. Keying
     * the TTL on `at` would hand retention to the learner's device — a phone
     * set to 2019 has its records expire on write, one set to 2035 keeps them
     * for a decade, and neither is a policy anyone chose.
     */
    const { getDb } = await load({ RETENTION_DAYS: "90" });

    await getDb();

    expect(ttlFor("attempts")?.keys).toEqual({ createdAt: 1 });
    expect(ttlFor("diagnostics")?.keys).toEqual({ createdAt: 1 });
  });

  it("converts the configured days into seconds", async () => {
    // Mongo takes seconds. A days-for-seconds mix-up would expire 90 days of
    // data in ninety seconds, or keep it 7,776,000 days.
    const { getDb } = await load({ RETENTION_DAYS: "30" });

    await getDb();

    expect(ttlFor("attempts")?.options?.expireAfterSeconds).toBe(30 * 24 * 60 * 60);
  });

  it("defaults to 90 days rather than to no expiry", async () => {
    // Unset must not mean "keep forever".
    const { getDb } = await load({ RETENTION_DAYS: undefined });

    await getDb();

    expect(ttlFor("attempts")?.options?.expireAfterSeconds).toBe(90 * 24 * 60 * 60);
  });

  it("keeps a real window on a malformed setting", async () => {
    /**
     * `Number("ninety")` is NaN, and an `expireAfterSeconds` of NaN is not a
     * retention policy — it is a rejected index and therefore indefinite
     * retention, logged and moved past. Guarded in server/env.ts.
     */
    const { getDb } = await load({ RETENTION_DAYS: "ninety" });

    await getDb();

    const seconds = ttlFor("attempts")?.options?.expireAfterSeconds;
    expect(Number.isFinite(seconds)).toBe(true);
    expect(seconds).toBe(90 * 24 * 60 * 60);
  });
});

describe("the query indexes", () => {
  it("indexes the sort every read actually uses", async () => {
    // Both list endpoints read most-recent-first. Without this each is a full
    // collection scan, which is fine at 139 records and not at the volume a
    // real fixture run produces.
    const { getDb } = await load();

    await getDb();

    for (const collection of ["attempts", "diagnostics"]) {
      expect(
        indexCalls.some((c) => c.collection === collection && c.keys.at === -1),
        collection,
      ).toBe(true);
    }
  });

  it("indexes sessionId, which is what correlates a funnel", async () => {
    // Tying an attempt to the diagnostics from the same session is the
    // designed analysis path, not an ad-hoc query.
    const { getDb } = await load();

    await getDb();

    for (const collection of ["attempts", "diagnostics"]) {
      expect(
        indexCalls.some((c) => c.collection === collection && c.keys.sessionId === 1),
        collection,
      ).toBe(true);
    }
  });
});

describe("connecting", () => {
  it("reuses one connection rather than reconnecting per request", async () => {
    const { getDb } = await load();

    await Promise.all([getDb(), getDb(), getDb()]);

    expect(connectCount).toBe(1);
  });

  it("returns the same promise to concurrent callers", async () => {
    // Several routes can race on the first request after boot; two clients
    // would be two connection pools.
    const { getDb } = await load();

    const [a, b] = await Promise.all([getDb(), getDb()]);

    expect(a).toBe(b);
  });

  it("retries after a failure instead of replaying the rejection forever", async () => {
    /**
     * The cache has to be cleared in the catch. Otherwise one unlucky
     * connection at boot — Mongo still starting, a momentary DNS failure —
     * poisons every later request for the lifetime of the process, and the
     * only fix is a restart nobody knows they need.
     */
    connectBehaviour = () => Promise.reject(new Error("ECONNREFUSED"));
    const { getDb } = await load();
    await expect(getDb()).rejects.toThrow();

    connectBehaviour = () => Promise.resolve();

    await expect(getDb()).resolves.toBeDefined();
    expect(connectCount).toBe(2);
  });

  it("uses the configured database name", async () => {
    const { getDb } = await load({ MONGO_DB: "sonare_test" });

    const db = await getDb();

    expect((db as unknown as { databaseName: string }).databaseName).toBe("sonare_test");
  });

  it("defaults to a local database rather than failing to start", async () => {
    const { getDb } = await load({ MONGO_DB: undefined, MONGO_URL: undefined });

    const db = await getDb();

    expect((db as unknown as { databaseName: string }).databaseName).toBe("sonare");
  });
});

describe("index creation is non-fatal", () => {
  it("still returns a usable database when an index cannot be created", async () => {
    /**
     * A conflicting TTL on an existing index is the realistic case: Mongo
     * rejects createIndex rather than adjusting an existing expireAfterSeconds,
     * so changing RETENTION_DAYS on a live database throws here on every boot.
     * That must cost query speed, not the server — but it does mean the new
     * window is *not* in force, which is why the failure is logged loudly.
     */
    createIndexFails = true;
    const { getDb } = await load();

    await expect(getDb()).resolves.toBeDefined();
  });

  it("does not poison the connection cache when only indexes failed", async () => {
    // The connection is fine; only the indexes are not. Clearing the cache
    // here would reconnect on every single request.
    createIndexFails = true;
    const { getDb } = await load();
    await getDb();

    await getDb();

    expect(connectCount).toBe(1);
  });
});
