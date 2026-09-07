/**
 * Registration, rotation, and the two middlewares that decide who a request is.
 *
 * Driven through real Express, because the thing being tested is a boundary:
 * what a caller can get by sending a header, not what a function returns when
 * called correctly. Written as an attacker — send someone else's id, send a
 * tampered token, send none at all, send a token to a route that must not
 * require one.
 *
 * The two middlewares are exercised on probe routes rather than only through
 * the real ones, so `optionalLearner`'s promise (never refuses) is asserted
 * directly instead of inferred.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

let learners: Map<string, Record<string, unknown>>;
let dbFails = false;

vi.mock("../db.js", () => ({
  getDb: () => {
    if (dbFails) return Promise.reject(new Error("no database"));
    return Promise.resolve({
      collection: () => ({
        updateOne: (filter: { _id: string }, update: Record<string, Record<string, unknown>>) => {
          const existing = learners.get(filter._id);
          // $setOnInsert only applies on insert. Applying it every time — the
          // obvious way to write this mock — would have quietly refreshed
          // createdAt and made the test below pass for the wrong reason.
          const onInsert = existing === undefined ? (update["$setOnInsert"] ?? {}) : {};
          learners.set(filter._id, { ...(existing ?? {}), ...onInsert, ...(update["$set"] ?? {}) });
          return Promise.resolve({ acknowledged: true });
        },
        findOne: (filter: { _id: string }) => Promise.resolve(learners.get(filter._id) ?? null),
        deleteOne: (filter: { _id: string }) => {
          learners.delete(filter._id);
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

/** A fresh app, since both the secret and the limiter are module state. */
async function start(secret: string | null = SECRET): Promise<void> {
  vi.resetModules();
  if (secret === null) delete process.env.LEARNER_TOKEN_SECRET;
  else process.env.LEARNER_TOKEN_SECRET = secret;

  const express = (await import("express")).default;
  const { learnersRouter } = await import("./learners.js");
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

beforeEach(async () => {
  learners = new Map();
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
