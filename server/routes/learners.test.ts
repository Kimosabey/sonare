/**
 * Registration, rotation, export, deletion, and the two middlewares that
 * decide who a request is.
 *
 * Driven through real Express, because the thing being tested is a boundary:
 * what a caller can get by sending a header, not what a function returns when
 * called correctly. Written as an attacker — send someone else's id, send a
 * tampered token, send none at all, send a token to a route that must not
 * require one, ask for somebody else's export.
 *
 * The two middlewares are exercised on probe routes rather than only through
 * the real ones, so `optionalLearner`'s promise (never refuses) is asserted
 * directly instead of inferred.
 *
 * The in-memory database is per collection and records which collections each
 * handler touched. That is what lets the export and the deletion be checked
 * against *each other* rather than each against a hand-written list — see
 * "export and delete agree" below.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

type Doc = Record<string, unknown> & { _id?: string };

/** Collection name to its documents, by id. */
let collections: Map<string, Map<string, Doc>>;
/** The learners collection, which most of the tests below read directly. */
let learners: Map<string, Doc>;
/** Every collection/operation pair a handler performed, in order. */
let touched: Array<{ collection: string; op: string }>;
let dbFails = false;

function col(name: string): Map<string, Doc> {
  const existing = collections.get(name);
  if (existing !== undefined) return existing;
  const created = new Map<string, Doc>();
  collections.set(name, created);
  return created;
}

/**
 * Equality, plus the one operator this project's queries use.
 *
 * `$regex` is here because `deleteRateLimitsFor` and `listRateLimitsFor` match
 * on `_id` — a limiter keying on the learner puts learner ids inside rate-limit
 * document ids, which is the bug that made those two functions necessary.
 */
function matches(doc: Doc, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([field, want]) => {
    const have = doc[field];
    if (typeof want === "object" && want !== null && "$regex" in want) {
      const pattern = (want as { $regex: string }).$regex;
      return typeof have === "string" && new RegExp(pattern).test(have);
    }
    return have === want;
  });
}

function find(name: string, filter: Record<string, unknown>): Doc[] {
  return [...col(name).values()].filter((doc) => matches(doc, filter));
}

/** One field, one direction — the only shape any query here asks for. */
function sorted(docs: Doc[], spec: Record<string, number>): Doc[] {
  const [field, direction] = Object.entries(spec)[0] ?? ["_id", 1];
  return [...docs].sort((a, b) => {
    const left = String(a[field] ?? "");
    const right = String(b[field] ?? "");
    return left < right ? -direction : left > right ? direction : 0;
  });
}

vi.mock("../db.js", () => ({
  getDb: () => {
    if (dbFails) return Promise.reject(new Error("no database"));
    return Promise.resolve({
      collection: (name: string) => ({
        updateOne: (
          filter: { _id: string },
          update: Record<string, Record<string, unknown>>,
          options?: { upsert?: boolean },
        ) => {
          touched.push({ collection: name, op: "updateOne" });
          const existing = col(name).get(filter._id);
          /**
           * No document and no upsert means no write, as the driver behaves.
           * Upserting unconditionally — the obvious way to write this mock —
           * made `touchLearner` look as though it *recreated* a learner record
           * on the next authenticated request after a deletion. It does not:
           * it updates `lastSeenAt` on a document that exists and otherwise
           * matches nothing. The mock was inventing a record the real one
           * never writes, which would have hidden a genuine deletion leak had
           * the code ever had one.
           */
          if (existing === undefined && options?.upsert !== true) {
            return Promise.resolve({ matchedCount: 0, acknowledged: true });
          }
          // $setOnInsert only applies on insert. Applying it every time would
          // have quietly refreshed createdAt and made the test below pass for
          // the wrong reason.
          const onInsert = existing === undefined ? (update["$setOnInsert"] ?? {}) : {};
          col(name).set(filter._id, {
            ...(existing ?? {}),
            _id: filter._id,
            ...onInsert,
            ...(update["$set"] ?? {}),
          });
          return Promise.resolve({ matchedCount: 1, acknowledged: true });
        },
        findOne: (filter: { _id: string }) => {
          touched.push({ collection: name, op: "findOne" });
          return Promise.resolve(col(name).get(filter._id) ?? null);
        },
        find: (filter: Record<string, unknown>) => {
          touched.push({ collection: name, op: "find" });
          const chain = {
            sort: (spec: Record<string, number>) => ({
              limit: (n: number) => ({
                toArray: () => Promise.resolve(sorted(find(name, filter), spec).slice(0, n)),
              }),
            }),
            toArray: () => Promise.resolve(find(name, filter)),
          };
          return chain;
        },
        deleteMany: (filter: Record<string, unknown>) => {
          touched.push({ collection: name, op: "deleteMany" });
          const doomed = find(name, filter);
          for (const doc of doomed) col(name).delete(String(doc._id));
          // deletedCount, as the driver returns. Without it the route's
          // reported counts vanish from the JSON.
          return Promise.resolve({ acknowledged: true, deletedCount: doomed.length });
        },
        deleteOne: (filter: { _id: string }) => {
          touched.push({ collection: name, op: "deleteOne" });
          col(name).delete(filter._id);
          return Promise.resolve({ acknowledged: true });
        },
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
let issueToken: (id: string, now?: number) => string;
/**
 * Read from the module under test rather than restated here. A list copied
 * into the test would keep agreeing with itself after the real one changed.
 */
let learnerCollections: readonly string[];
let exportMaxRecords: number;

/** A fresh app, since both the secret and the limiter are module state. */
async function start(secret: string | null = SECRET): Promise<void> {
  vi.resetModules();
  if (secret === null) delete process.env.LEARNER_TOKEN_SECRET;
  else process.env.LEARNER_TOKEN_SECRET = secret;

  const express = (await import("express")).default;
  const learnersModule = await import("./learners.js");
  const { learnersRouter } = learnersModule;
  learnerCollections = learnersModule.LEARNER_COLLECTIONS;
  exportMaxRecords = learnersModule.EXPORT_MAX_RECORDS;
  const { requireLearner, optionalLearner, learnerIdFrom } = await import("../middleware/identity.js");
  issueToken = (await import("../identity.js")).issueToken;

  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use("/api/v1", learnersRouter);

  // Probes, so each middleware's contract is asserted directly.
  app.get("/probe/required", requireLearner, (_q, res) => void res.json({ learnerId: learnerIdFrom(res) }));
  app.get("/probe/optional", optionalLearner, (_q, res) => void res.json({ learnerId: learnerIdFrom(res) }));

  await new Promise<void>((ready) => {
    server = app.listen(0, () => ready());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function post(path: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // A distinct IP per call so the shared limiter is never the thing under
      // test here.
      "x-forwarded-for": `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function get(path: string, token?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    headers: {
      "x-forwarded-for": `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

async function del(path: string, token?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "DELETE",
    headers: {
      "x-forwarded-for": `10.7.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

beforeEach(async () => {
  collections = new Map();
  // Held by reference, so the tests that read it directly see every write the
  // handlers make through `col("learners")`.
  learners = col("learners");
  touched = [];
  dbFails = false;
  await start();
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  delete process.env.LEARNER_TOKEN_SECRET;
  vi.clearAllMocks();
});

describe("registering", () => {
  it("returns a token for a well-formed id", async () => {
    const res = await post("/api/v1/learners", { learnerId: A });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { token: string }).token.startsWith(`${A}.`)).toBe(true);
  });

  it("records the learner with the name they chose", async () => {
    await post("/api/v1/learners", { learnerId: A, displayName: "Marie", locale: "fr-FR" });

    // The write is fire-and-forget, so give the microtask queue a turn.
    await new Promise((r) => setTimeout(r, 10));

    expect(learners.get(A)).toMatchObject({ displayName: "Marie", locale: "fr-FR" });
  });

  it("keeps the original createdAt for a returning learner", async () => {
    // Otherwise every learner looks new on every visit, and the only figure
    // the field is good for is ruined.
    await post("/api/v1/learners", { learnerId: A });
    await new Promise((r) => setTimeout(r, 10));
    const first = learners.get(A)?.["createdAt"];

    await post("/api/v1/learners", { learnerId: A });
    await new Promise((r) => setTimeout(r, 10));

    expect(learners.get(A)?.["createdAt"]).toEqual(first);
  });

  it("does not erase a name when a later request omits it", async () => {
    await post("/api/v1/learners", { learnerId: A, displayName: "Marie" });
    await new Promise((r) => setTimeout(r, 10));

    await post("/api/v1/learners", { learnerId: A });
    await new Promise((r) => setTimeout(r, 10));

    expect(learners.get(A)?.["displayName"]).toBe("Marie");
  });

  it.each([
    ["missing", {}],
    ["not a uuid", { learnerId: "marie" }],
    ["empty", { learnerId: "" }],
    ["a path", { learnerId: "../../etc/passwd" }],
    ["a mongo operator", { learnerId: { $ne: null } }],
    ["the wrong uuid version", { learnerId: A.replace("-4", "-9") }],
    ["enormous", { learnerId: "x".repeat(10_000) }],
  ])("refuses an id that is %s", async (_label, body) => {
    const res = await post("/api/v1/learners", body);

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID_REQUEST");
  });

  it("still issues a token when the database write fails", async () => {
    /**
     * The token is already valid and the learner can practise; the record gets
     * created by the next sync. Failing here would cost a learner their
     * session to save us a row.
     */
    dbFails = true;

    const res = await post("/api/v1/learners", { learnerId: A });

    expect(res.status).toBe(200);
  });
});

describe("the token is the credential, not the id", () => {
  it("refuses a bare id on a protected route", async () => {
    // The whole reason the signing exists. Anyone can send anyone's id.
    const res = await get("/probe/required", A);

    expect(res.status).toBe(401);
  });

  it("accepts a real token and resolves the right learner", async () => {
    const res = await get("/probe/required", issueToken(A));

    expect(res.status).toBe(200);
    expect(((await res.json()) as { learnerId: string }).learnerId).toBe(A);
  });

  it("refuses a token whose id was swapped for someone else's", async () => {
    const parts = issueToken(A).split(".");
    const forged = [B, parts[1], parts[2]].join(".");

    expect((await get("/probe/required", forged)).status).toBe(401);
  });

  it("refuses a token signed with a different secret", async () => {
    const stolen = issueToken(A);
    await new Promise<void>((done) => server.close(() => done()));
    await start("a-completely-different-secret");

    expect((await get("/probe/required", stolen)).status).toBe(401);
  });

  it("refuses a missing header", async () => {
    expect((await get("/probe/required")).status).toBe(401);
  });

  it("says nothing about why it refused", async () => {
    /**
     * "Expired" versus "bad signature" tells an attacker which half of a guess
     * was right, and the client does the same thing either way: mint a new id
     * and register again.
     */
    const tampered = `${issueToken(A).slice(0, -4)}zzzz`;
    const expired = issueToken(A, 1_000_000_000_000);

    const one = (await (await get("/probe/required", tampered)).json()) as { error: { message: string } };
    const two = (await (await get("/probe/required", expired)).json()) as { error: { message: string } };

    expect(one.error.message).toBe(two.error.message);
    expect(one.error.message).not.toMatch(/expired|signature/i);
  });

  it("rotates to a new token for the same learner", async () => {
    const original = issueToken(A, Date.now() - 60_000);

    const res = await post("/api/v1/learners/rotate", {}, original);
    const rotated = ((await res.json()) as { token: string }).token;

    expect(res.status).toBe(200);
    expect(rotated).not.toBe(original);
    expect((await get("/probe/required", rotated)).status).toBe(200);
  });

  it("will not rotate without a valid token", async () => {
    expect((await post("/api/v1/learners/rotate", {}, A)).status).toBe(401);
    expect((await post("/api/v1/learners/rotate", {})).status).toBe(401);
  });
});

describe("optional identity", () => {
  it("lets an anonymous request through", async () => {
    /**
     * Scoring depends on this. A learner who has never registered must still
     * be able to practise, so identity is an attribution bonus and never a
     * precondition.
     */
    const res = await get("/probe/optional");

    expect(res.status).toBe(200);
    expect(((await res.json()) as { learnerId: string | null }).learnerId).toBeNull();
  });

  it("attaches the learner when the token is good", async () => {
    const res = await get("/probe/optional", issueToken(A));

    expect(((await res.json()) as { learnerId: string }).learnerId).toBe(A);
  });

  it("ignores a bad token rather than refusing the request", async () => {
    // An expired token must not stop someone practising.
    const res = await get("/probe/optional", `${A}.1.not-a-signature`);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { learnerId: string | null }).learnerId).toBeNull();
  });
});

/** One document in every collection that can hold something about a learner. */
function fillEverything(learnerId: string): void {
  col("attempts").set(`${learnerId}:a`, {
    _id: `${learnerId}:a`,
    learnerId,
    at: "2026-09-01T10:00:00.000Z",
    referenceText: "Bonjour",
    // The shape of the recording, never the recording. Asserted below.
    audio: { bytes: 32_000, seconds: 1, sampleRate: 16_000, channels: 1, bitsPerSample: 16 },
  });
  col("diagnostics").set(`${learnerId}:d`, {
    _id: `${learnerId}:d`,
    learnerId,
    at: "2026-09-01T10:00:00.000Z",
    code: "MIC_BLOCKED",
    domain: "client",
    message: "no permission",
  });
  // Ids of the shape a learner-keyed limiter writes — the reason this
  // collection is part of a data request at all.
  col("ratelimits").set(`scoring-learner:${learnerId}:0`, {
    _id: `scoring-learner:${learnerId}:0`,
    hits: 3,
    expiresAt: new Date("2026-09-01T10:02:00.000Z"),
  });
  col("progress").set(`${learnerId}:fr`, {
    _id: `${learnerId}:fr`,
    learnerId,
    slug: "fr",
    entries: [{ activityId: 1, passed: true, bestAccuracy: 88, attemptsUsed: 2, skipped: false, at: "2026-09-01T10:00:00.000Z" }],
    version: 1,
  });
  col("skills").set(`${learnerId}:fr`, {
    _id: `${learnerId}:fr`,
    learnerId,
    slug: "fr",
    skills: [{ grapheme: "ment", samples: [{ at: "2026-09-01T10:00:00.000Z", accuracy: 61 }] }],
    version: 1,
  });
  col("streaks").set(learnerId, {
    _id: learnerId,
    learnerId,
    days: ["2026-09-01"],
    longest: 1,
    version: 1,
  });
  col("learners").set(learnerId, { _id: learnerId, displayName: "Marie", locale: "fr-FR" });
}

interface ExportBody {
  format: number;
  exportedAt: string;
  learnerId: string;
  collections: Record<string, unknown>;
  truncated: Record<string, boolean>;
}

describe("exporting a learner's own record", () => {
  it("is mounted where the client looks for it", async () => {
    // A router mounted at the wrong prefix is invisible to a unit test that
    // mounts its own app, and shows up as a client that silently cannot reach
    // the server. Any status but 404 means the route exists.
    expect((await get("/api/v1/learners/me/export")).status).not.toBe(404);
  });

  it("hands back every collection with something in it", async () => {
    fillEverything(A);

    const res = await get("/api/v1/learners/me/export", issueToken(A));
    const body = (await res.json()) as ExportBody;

    expect(res.status).toBe(200);
    expect(body.learnerId).toBe(A);
    expect(body.collections["attempts"]).toHaveLength(1);
    expect(body.collections["diagnostics"]).toHaveLength(1);
    expect(body.collections["ratelimits"]).toHaveLength(1);
    expect(body.collections["progress"]).toHaveLength(1);
    expect(body.collections["skills"]).toHaveLength(1);
    expect(body.collections["streaks"]).toMatchObject({ days: ["2026-09-01"], longest: 1 });
    expect(body.collections["learners"]).toMatchObject({ displayName: "Marie" });
  });

  it("names every collection even when the learner has nothing", async () => {
    /**
     * A key missing because a collection was empty is indistinguishable from
     * a key missing because the export forgot it — and the second is the
     * failure this whole feature can have without anyone noticing.
     */
    const res = await get("/api/v1/learners/me/export", issueToken(A));
    const body = (await res.json()) as ExportBody;

    expect(Object.keys(body.collections).sort()).toEqual([...learnerCollections].sort());
    expect(body.collections["streaks"]).toBeNull();
    expect(body.collections["learners"]).toBeNull();
  });

  it("returns nobody else's record", async () => {
    fillEverything(A);
    fillEverything(B);

    const res = await get("/api/v1/learners/me/export", issueToken(A));

    // Not "the counts are 1": that would pass if it returned one of each
    // belonging to somebody else. Nothing in the body may mention them.
    expect(JSON.stringify(await res.json())).not.toContain(B);
  });

  it("refuses a bare id, and no token at all", async () => {
    // Otherwise anyone could read anyone's record by sending their id — which
    // is worse here than on the deletion, because it is silent.
    fillEverything(A);

    expect((await get("/api/v1/learners/me/export", A)).status).toBe(401);
    expect((await get("/api/v1/learners/me/export")).status).toBe(401);
  });

  it("carries no audio, because none is stored", async () => {
    fillEverything(A);

    const body = (await (await get("/api/v1/learners/me/export", issueToken(A))).json()) as ExportBody;
    const attempts = body.collections["attempts"] as Array<{ audio: Record<string, unknown> }>;

    // The measurements of the recording, and nothing that could reconstruct
    // it. No audio is kept per learner and that has to stay true of the
    // export as well as of the database.
    expect(attempts[0]?.audio).toEqual({
      bytes: 32_000,
      seconds: 1,
      sampleRate: 16_000,
      channels: 1,
      bitsPerSample: 16,
    });
    expect(JSON.stringify(body)).not.toMatch(/data:audio|"wav"|base64/);
  });

  it("says when it had to cut a trail short", async () => {
    /**
     * A cap is necessary — the attempt trail grows with every take — but a
     * silent one turns the export into a partial copy claiming to be whole.
     */
    for (let i = 0; i <= exportMaxRecords; i += 1) {
      const id = `${A}:${i}`;
      col("attempts").set(id, { _id: id, learnerId: A, at: `2026-09-01T10:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(4, "0")}Z` });
    }

    const body = (await (await get("/api/v1/learners/me/export", issueToken(A))).json()) as ExportBody;

    expect(body.collections["attempts"]).toHaveLength(exportMaxRecords);
    expect(body.truncated["attempts"]).toBe(true);
    expect(body.truncated["diagnostics"]).toBe(false);
  });

  it("keeps the most recent takes when it truncates", async () => {
    // Cutting the newest would leave a learner the half of their history they
    // are least likely to want.
    for (let i = 0; i <= exportMaxRecords; i += 1) {
      const id = `${A}:${i}`;
      col("attempts").set(id, { _id: id, learnerId: A, at: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T10:00:00.000Z` });
    }

    const body = (await (await get("/api/v1/learners/me/export", issueToken(A))).json()) as ExportBody;
    const attempts = body.collections["attempts"] as Array<{ at: string }>;

    expect(attempts[0]?.at).toBe("2026-09-28T10:00:00.000Z");
  });

  it("fails the whole request rather than returning a partial record", async () => {
    // A partial export presented as a complete one is worse than none: it is
    // the document a learner would use to check a deletion against.
    fillEverything(A);
    const token = issueToken(A);
    dbFails = true;

    const res = await get("/api/v1/learners/me/export", token);

    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("PROVIDER_UNAVAILABLE");
  });
});

describe("export and delete agree about what everything means", () => {
  it("erases exactly the collections the export covers", async () => {
    /**
     * The property both features rest on, checked against each other rather
     * than against a list written twice.
     *
     * This is the shape of a bug that already happened: a limiter keyed on the
     * learner put learner ids into rate-limit document ids, and the deletion
     * knew nothing about that collection, so "delete my data" left them
     * behind. `LEARNER_COLLECTIONS` types the export's keys, so a collection
     * added to the deletion and forgotten there is a compile error; this
     * asserts the other direction — that the deletion really does reach every
     * name on the list — so neither half can quietly drift from the other.
     */
    fillEverything(A);
    touched = [];

    const res = await del("/api/v1/learners/me", issueToken(A));
    expect(res.status).toBe(200);

    const erased = [
      ...new Set(touched.filter((t) => t.op.startsWith("delete")).map((t) => t.collection)),
    ].sort();
    expect(erased).toEqual([...learnerCollections].sort());
  });

  it("leaves nothing an export would have found", async () => {
    // The client-facing version of the end-to-end assertion: export, delete,
    // export again, and the second export is empty everywhere.
    fillEverything(A);
    const token = issueToken(A);

    expect((await del("/api/v1/learners/me", token)).status).toBe(200);

    const after = (await (await get("/api/v1/learners/me/export", token)).json()) as ExportBody;
    for (const name of learnerCollections) {
      const value = after.collections[name];
      expect(Array.isArray(value) ? value : (value ?? [])).toHaveLength(0);
    }
  });

  it("is not undone by the next authenticated request", async () => {
    /**
     * `requireLearner` touches `lastSeenAt` on every authenticated request. If
     * that write upserted, a learner who deleted their record and then made
     * one more request — the retry, or the export above — would have it
     * silently recreated, and a deletion that reappears is not a deletion.
     * It does not upsert, and this is what says so out loud.
     */
    fillEverything(A);
    const token = issueToken(A);
    await del("/api/v1/learners/me", token);

    await get("/api/v1/learners/me/export", token);
    await post("/api/v1/learners/rotate", {}, token);

    expect(col("learners").get(A)).toBeUndefined();
  });

  it("erases nobody else's record", async () => {
    fillEverything(A);
    fillEverything(B);

    await del("/api/v1/learners/me", issueToken(A));

    const theirs = (await (await get("/api/v1/learners/me/export", issueToken(B))).json()) as ExportBody;
    expect(theirs.collections["attempts"]).toHaveLength(1);
    expect(theirs.collections["learners"]).not.toBeNull();
  });
});

describe("with no secret configured", () => {
  beforeEach(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    await start(null);
  });

  it("reports the feature unavailable rather than letting anyone in", async () => {
    const res = await get("/probe/required", A);

    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("MISCONFIGURED");
  });

  it("refuses to register, rather than issuing an unsigned token", async () => {
    const res = await post("/api/v1/learners", { learnerId: A });

    expect(res.status).toBe(503);
  });

  it("still lets optional routes serve anonymous requests", async () => {
    // Identity being off must not take scoring down with it.
    const res = await get("/probe/optional");

    expect(res.status).toBe(200);
  });
});
