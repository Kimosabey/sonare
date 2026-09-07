/**
 * The endpoint that finally carries a learner's own record both ways.
 *
 * Driven through real Express, because what is being tested is a boundary:
 * what a caller gets back for what they send, including when they send
 * nonsense or nothing or somebody else's token.
 *
 * The merge rules themselves are covered in domain/. What matters here is the
 * contract around them — that identity is required, that a partial push is not
 * a partial truth, that a failed save tells the learner the honest thing, and
 * that nothing a client sends is trusted on its way to being displayed back to
 * them as their own history.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

interface Doc {
  _id: string;
  learnerId: string;
  version: number;
  [key: string]: unknown;
}

let store: Map<string, Doc>;
let dbFails = false;

vi.mock("../db.js", () => ({
  getDb: () => {
    if (dbFails) return Promise.reject(new Error("no database"));
    return Promise.resolve({
      collection: (name: string) => ({
        findOne: (f: { _id: string }) => Promise.resolve(structuredClone(store.get(`${name}/${f._id}`) ?? null)),
        find: (f: { learnerId: string }) => ({
          toArray: () =>
            Promise.resolve(
              [...store.entries()]
                .filter(([k, v]) => k.startsWith(`${name}/`) && v.learnerId === f.learnerId)
                .map(([, v]) => structuredClone(v)),
            ),
        }),
        insertOne: (doc: Doc) => {
          const key = `${name}/${doc._id}`;
          if (store.has(key)) {
            const err = new Error("dup") as Error & { code: number };
            err.code = 11000;
            return Promise.reject(err);
          }
          store.set(key, structuredClone(doc));
          return Promise.resolve({ acknowledged: true });
        },
        updateOne: (f: { _id: string; version?: number }, u: Record<string, Record<string, unknown>>) => {
          const key = `${name}/${f._id}`;
          const existing = store.get(key);
          if (existing === undefined || (f.version !== undefined && existing.version !== f.version)) {
            return Promise.resolve({ matchedCount: 0, acknowledged: true });
          }
          store.set(key, { ...existing, ...(u["$set"] ?? {}), version: existing.version + 1 } as Doc);
          return Promise.resolve({ matchedCount: 1, acknowledged: true });
        },
        deleteMany: () => Promise.resolve({ acknowledged: true }),
        createIndex: () => Promise.resolve("ok"),
      }),
    });
  },
}));

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const A = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const B = "11111111-2222-4333-8444-555555555555";
const SECRET = "test-secret-not-a-real-one";

let server: Server;
let base: string;
let tokenFor: (id: string) => string;

interface Snapshot {
  progress: Array<{ slug: string; entries: Array<{ activityId: number; passed: boolean; bestAccuracy: number | null }> }>;
  skills: Array<{ slug: string; skills: Array<{ grapheme: string; samples: Array<{ at: string; accuracy: number }> }> }>;
  streak: { days: string[]; longest: number };
}

async function start(): Promise<void> {
  vi.resetModules();
  process.env.LEARNER_TOKEN_SECRET = SECRET;

  const express = (await import("express")).default;
  const { syncRouter } = await import("./sync.js");
  const { issueToken } = await import("../identity.js");
  tokenFor = (id: string) => issueToken(id);

  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use("/api/v1", syncRouter);

  await new Promise<void>((ready) => {
    server = app.listen(0, () => ready());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function headers(token?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-forwarded-for": `10.7.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
    ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function push(body: unknown, token?: string): Promise<Response> {
  return fetch(`${base}/api/v1/sync`, { method: "POST", headers: headers(token), body: JSON.stringify(body) });
}

async function pull(token?: string): Promise<Response> {
  return fetch(`${base}/api/v1/sync`, { headers: headers(token) });
}

function entry(over: Record<string, unknown> = {}) {
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

beforeEach(async () => {
  store = new Map();
  dbFails = false;
  await start();
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  delete process.env.LEARNER_TOKEN_SECRET;
  vi.clearAllMocks();
});

describe("identity is required", () => {
  it("refuses a pull without a token", async () => {
    expect((await pull()).status).toBe(401);
  });

  it("refuses a push without a token", async () => {
    expect((await push({ streak: { days: ["2026-09-07"], longest: 1 } })).status).toBe(401);
  });

  it("refuses a bare learner id in place of a token", async () => {
    // A learner id is not a credential. This is the whole reason for signing.
    expect((await pull(A)).status).toBe(401);
  });

  it("keeps two learners' records apart", async () => {
    await push({ streak: { days: ["2026-09-07"], longest: 1 } }, tokenFor(A));

    const mine = (await (await pull(tokenFor(A))).json()) as Snapshot;
    const theirs = (await (await pull(tokenFor(B))).json()) as Snapshot;

    expect(mine.streak.days).toEqual(["2026-09-07"]);
    expect(theirs.streak.days).toEqual([]);
  });
});

describe("a first visit", () => {
  it("pulls an empty record rather than an error", async () => {
    const res = await pull(tokenFor(A));

    expect(res.status).toBe(200);
    expect((await res.json()) as Snapshot).toEqual({ progress: [], skills: [], streak: { days: [], longest: 0 } });
  });
});

describe("push is also pull", () => {
  it("returns the merged record, not just what was sent", async () => {
    await push({ progress: [{ slug: "fr", entries: [entry({ activityId: 2, passed: true })] }] }, tokenFor(A));

    const body = (await (await push({ progress: [{ slug: "fr", entries: [entry({ activityId: 1, passed: true })] }] }, tokenFor(A))).json()) as Snapshot;

    expect(body.progress[0]?.entries.map((e) => e.activityId)).toEqual([1, 2]);
  });

  it("returns domains this push did not touch", async () => {
    /**
     * The client stores the whole response, so a reply missing a domain would
     * read as "that domain is empty" and wipe it locally.
     */
    await push({ streak: { days: ["2026-09-06"], longest: 1 } }, tokenFor(A));

    const body = (await (await push({ progress: [{ slug: "fr", entries: [entry()] }] }, tokenFor(A))).json()) as Snapshot;

    expect(body.streak.days).toEqual(["2026-09-06"]);
  });

  it("accepts a push with nothing in it", async () => {
    // A client with nothing dirty still polls, and that must not be an error.
    const res = await push({}, tokenFor(A));

    expect(res.status).toBe(200);
  });

  it("carries all three domains at once", async () => {
    const res = await push(
      {
        progress: [{ slug: "fr", entries: [entry({ passed: true })] }],
        skills: [{ slug: "fr", skills: [{ grapheme: "ment", samples: [{ at: "2026-09-07T10:00:00.000Z", accuracy: 61 }] }] }],
        streak: { days: ["2026-09-07"], longest: 1 },
      },
      tokenFor(A),
    );
    const body = (await res.json()) as Snapshot;

    expect(body.progress).toHaveLength(1);
    expect(body.skills[0]?.skills[0]?.grapheme).toBe("ment");
    expect(body.streak.days).toEqual(["2026-09-07"]);
  });

  it("survives the same push arriving twice", async () => {
    const body = { streak: { days: ["2026-09-07"], longest: 1 }, skills: [{ slug: "fr", skills: [{ grapheme: "ment", samples: [{ at: "2026-09-07T10:00:00.000Z", accuracy: 61 }] }] }] };
    await push(body, tokenFor(A));

    const second = (await (await push(body, tokenFor(A))).json()) as Snapshot;

    expect(second.streak.days).toEqual(["2026-09-07"]);
    expect(second.skills[0]?.skills[0]?.samples).toHaveLength(1);
  });
});

describe("nothing a client sends is trusted", () => {
  it("drops a language whose slug is not a slug", async () => {
    const res = await push({ progress: [{ slug: "../../etc", entries: [entry()] }] }, tokenFor(A));

    expect(((await res.json()) as Snapshot).progress).toEqual([]);
  });

  it("clamps an impossible score before it is stored", async () => {
    /**
     * This comes back to the learner as their best score, and it merges by
     * MAX — so an unclamped 8000 would render as nonsense and could never be
     * displaced by a real result.
     */
    const res = await push({ progress: [{ slug: "fr", entries: [entry({ bestAccuracy: 8000 })] }] }, tokenFor(A));

    expect(((await res.json()) as Snapshot).progress[0]?.entries[0]?.bestAccuracy).toBe(100);
  });

  it("ignores a fabricated practice day", async () => {
    const res = await push({ streak: { days: ["2026-99-99", "2026-02-30", "2026-09-07"], longest: 1 } }, tokenFor(A));

    expect(((await res.json()) as Snapshot).streak.days).toEqual(["2026-09-07"]);
  });

  it("ignores junk in place of a domain", async () => {
    const res = await push({ progress: "everything", skills: 42, streak: "long" }, tokenFor(A));

    expect(res.status).toBe(200);
    expect((await res.json()) as Snapshot).toMatchObject({ progress: [], skills: [] });
  });

  it("bounds how many languages one push can enqueue", async () => {
    // Each language is a read-modify-write with retries, which makes an
    // unbounded list the cheapest denial of service against this endpoint.
    const many = Array.from({ length: 60 }, (_, i) => ({
      slug: `l${String.fromCharCode(97 + (i % 26))}`,
      entries: [entry()],
    }));

    const res = await push({ progress: many }, tokenFor(A));

    expect(((await res.json()) as Snapshot).progress.length).toBeLessThanOrEqual(12);
  });
});

describe("when the database is unreachable", () => {
  it("says the progress is safe locally, because it is", async () => {
    /**
     * The local write already succeeded before this request was made, so this
     * is genuinely not something the learner needs to act on. Implying lost
     * work would be both alarming and false.
     */
    dbFails = true;

    const res = await push({ streak: { days: ["2026-09-07"], longest: 1 } }, tokenFor(A));
    const body = (await res.json()) as { error: { userMessage: string } };

    expect(res.status).toBe(503);
    expect(body.error.userMessage).toMatch(/saved on this device/i);
    expect(body.error.userMessage).not.toMatch(/lost|failed|error/i);
  });

  it("fails a pull without pretending the record is empty", async () => {
    // Returning an empty snapshot would look like success and would let a
    // client overwrite real server state with nothing.
    dbFails = true;

    expect((await pull(tokenFor(A))).status).toBe(503);
  });
});
