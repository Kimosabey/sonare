/**
 * The two device-linking endpoints, over real HTTP.
 *
 * Kept out of learners.test.ts because these need something that file
 * deliberately avoids: the real limiters actually firing. Everywhere else in
 * this project a test gives each simulated caller its own `X-Forwarded-For`
 * precisely so the shared limiter is never what fails — and here the limiter
 * *is* part of what is being asserted, because a link code is a bearer
 * credential and its rate limit is half of the brute-force arithmetic.
 *
 * Written as an attacker. The questions are whether a guess can be repeated,
 * whether a refusal says what exists, whether a code survives a claim, and
 * whether the endpoint answers at all with identity switched off.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

type Doc = Record<string, unknown> & { _id: string };

let store: Map<string, Map<string, Doc>>;
let dbFails = false;

function col(name: string): Map<string, Doc> {
  const existing = store.get(name);
  if (existing !== undefined) return existing;
  const created = new Map<string, Doc>();
  store.set(name, created);
  return created;
}

/**
 * Strict in both directions, like the end-to-end mock: every condition has to
 * hold, and an operator it does not implement throws rather than being
 * ignored. A silently dropped `$gt` would remove the expiry check from the
 * claim filter and leave the expiry assertions below passing vacuously.
 */
function matches(doc: Doc, filter: Record<string, unknown>): boolean {
  for (const [field, condition] of Object.entries(filter)) {
    const value = doc[field];

    if (typeof condition === "object" && condition !== null && !(condition instanceof Date)) {
      const ops = condition as { $gt?: unknown; $regex?: unknown };
      if (ops.$gt instanceof Date) {
        if (!(value instanceof Date) || value.getTime() <= ops.$gt.getTime()) return false;
        continue;
      }
      if (typeof ops.$gt === "number") {
        if (typeof value !== "number" || value <= ops.$gt) return false;
        continue;
      }
      if (typeof ops.$regex === "string") {
        if (typeof value !== "string" || !new RegExp(ops.$regex).test(value)) return false;
        continue;
      }
      throw new Error(`link-route mock: filter on ${field} uses an operator it does not implement`);
    }

    if (condition instanceof Date) {
      if (!(value instanceof Date) || value.getTime() !== condition.getTime()) return false;
      continue;
    }
    if (value !== condition) return false;
  }
  return true;
}

vi.mock("../db.js", () => ({
  getDb: () => {
    if (dbFails) return Promise.reject(new Error("no database"));
    return Promise.resolve({
      collection: (name: string) => ({
        // Mutates synchronously and only then resolves, which is Mongo's own
        // guarantee for a single document.
        updateOne: async (
          filter: Record<string, unknown> & { _id: string },
          update: Record<string, Record<string, unknown>>,
          options?: { upsert?: boolean },
        ) => {
          const existing = col(name).get(filter._id);
          if (existing === undefined && options?.upsert !== true) {
            return { matchedCount: 0, acknowledged: true };
          }
          if (existing !== undefined && !matches(existing, filter)) {
            return { matchedCount: 0, acknowledged: true };
          }
          const onInsert = existing === undefined ? (update["$setOnInsert"] ?? {}) : {};
          col(name).set(filter._id, {
            ...(existing ?? {}),
            _id: filter._id,
            ...onInsert,
            ...(update["$set"] ?? {}),
          } as Doc);
          return { matchedCount: 1, acknowledged: true };
        },
        findOneAndUpdate: async (
          filter: Record<string, unknown> & { _id: string },
          update: Record<string, Record<string, unknown>>,
        ) => {
          // The rate limiters' shape: a conditional upsert, which collides on
          // `_id` when the filter does not match what is there.
          const existing = col(name).get(filter._id);
          if (existing !== undefined && !matches(existing, filter)) {
            const err = new Error("E11000 duplicate key") as Error & { code: number };
            err.code = 11000;
            throw err;
          }
          const onInsert = existing === undefined ? (update["$setOnInsert"] ?? {}) : {};
          const next: Doc = { ...(existing ?? {}), _id: filter._id, ...onInsert } as Doc;
          for (const [field, by] of Object.entries(update["$inc"] ?? {})) {
            next[field] = ((next[field] as number) ?? 0) + (by as number);
          }
          Object.assign(next, update["$set"] ?? {});
          col(name).set(filter._id, next);
          return next;
        },
        insertOne: async (doc: Doc) => {
          if (col(name).has(doc._id)) {
            const err = new Error("E11000 duplicate key") as Error & { code: number };
            err.code = 11000;
            throw err;
          }
          col(name).set(doc._id, { ...doc });
          return { acknowledged: true, insertedId: doc._id };
        },
        // The whole filter, not only `_id` — a read that ignores its extra
        // conditions makes every condition on a read invisible.
        findOne: async (filter: Record<string, unknown> & { _id: string }) => {
          const doc = col(name).get(filter._id);
          if (doc === undefined) return null;
          return matches(doc, filter) ? doc : null;
        },
        find: (filter: Record<string, unknown>) => ({
          sort: () => ({
            limit: (n: number) => ({
              toArray: async () => [...col(name).values()].filter((doc) => matches(doc, filter)).slice(0, n),
            }),
          }),
          toArray: async () => [...col(name).values()].filter((doc) => matches(doc, filter)),
        }),
        deleteMany: async (filter: Record<string, unknown>) => {
          let deletedCount = 0;
          for (const [id, doc] of col(name)) {
            if (matches(doc, filter)) {
              col(name).delete(id);
              deletedCount += 1;
            }
          }
          return { acknowledged: true, deletedCount };
        },
        deleteOne: async (filter: { _id: string }) => {
          col(name).delete(filter._id);
          return { acknowledged: true };
        },
        createIndex: async () => "ok",
      }),
    });
  },
}));

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const A = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const B = "11111111-2222-4333-8444-555555555555";
const SECRET = "link-route-test-secret-not-a-real-one";

let server: Server;
let base: string;
let issueToken: (id: string) => string;
/** Read from the running app's own module instance, never restated here. */
let limits: {
  claimPerAddress: number;
  claimGlobal: number;
  mintPerLearner: number;
};

/**
 * A fresh app. The secret, the TTL and every limiter are module state, so a
 * value set after the import configures a module the server is not using —
 * the mistake that has made four assertions in this project pass against the
 * wrong instance.
 */
async function start(secret: string | null = SECRET): Promise<void> {
  vi.resetModules();
  if (secret === null) delete process.env.LEARNER_TOKEN_SECRET;
  else process.env.LEARNER_TOKEN_SECRET = secret;

  const express = (await import("express")).default;
  const { learnersRouter } = await import("./learners.js");
  const rateLimit = await import("../rateLimit.js");
  issueToken = (await import("../identity.js")).issueToken;
  limits = {
    claimPerAddress: rateLimit.LINK_CLAIM_PER_ADDRESS_LIMIT,
    claimGlobal: rateLimit.LINK_CLAIM_GLOBAL_LIMIT,
    mintPerLearner: rateLimit.LINK_MINT_PER_LEARNER_LIMIT,
  };

  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use("/api/v1", learnersRouter);

  await new Promise<void>((ready) => {
    server = app.listen(0, () => ready());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A distinct address per caller, so a per-address limit is opt-in here. */
function address(): string {
  return `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
}

async function post(
  path: string,
  body: unknown,
  options: { token?: string; from?: string } = {},
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": options.from ?? address(),
      ...(options.token !== undefined ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

interface Minted {
  code: string;
  expiresAt: string;
  expiresInSeconds: number;
}

interface Claimed {
  token?: string;
  learnerId?: string;
  error?: { code: string; domain: string; message: string; userMessage: string };
}

async function mint(learnerId: string): Promise<Minted> {
  const res = await post("/api/v1/learners/me/link", {}, { token: issueToken(learnerId) });
  if (res.status !== 200) throw new Error(`mint failed: ${res.status}`);
  return (await res.json()) as Minted;
}

async function claim(code: unknown, from?: string): Promise<Response> {
  return post("/api/v1/learners/link/claim", { code }, from === undefined ? {} : { from });
}

/** The one stored row for a learner's code, for the tests that age it. */
function rowFor(learnerId: string): Doc | undefined {
  return [...col("linkcodes").values()].find((doc) => doc["learnerId"] === learnerId);
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

describe("minting a link code", () => {
  it("is mounted where the client looks for it", async () => {
    // A router mounted at the wrong prefix is invisible to a unit test that
    // builds its own app, and shows up as a client that silently cannot reach
    // the server.
    expect((await post("/api/v1/learners/me/link", {})).status).not.toBe(404);
  });

  it("returns a code and when it dies", async () => {
    const res = await post("/api/v1/learners/me/link", {}, { token: issueToken(A) });
    const body = (await res.json()) as Minted;

    expect(res.status).toBe(200);
    expect(body.code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    expect(body.expiresInSeconds).toBe(600);
    // Stated as an instant as well as a duration, so a client with a skewed
    // clock can show a countdown that is wrong in the honest direction.
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("refuses a bare learner id, and no token at all", async () => {
    // The whole reason the token exists. If an id were enough, anyone could
    // mint a code for anyone and then claim it — which is a full account
    // takeover through the feature meant to prevent an account being lost.
    expect((await post("/api/v1/learners/me/link", {}, { token: A })).status).toBe(401);
    expect((await post("/api/v1/learners/me/link", {})).status).toBe(401);
  });

  it("binds the code to the caller, not to anyone they name in the body", async () => {
    // A handler that read a learner id out of the body would let a caller
    // mint a code for somebody else's record.
    const res = await post("/api/v1/learners/me/link", { learnerId: B }, { token: issueToken(A) });
    const { code } = (await res.json()) as Minted;

    const claimed = (await (await claim(code)).json()) as Claimed;

    expect(claimed.learnerId).toBe(A);
  });

  it("stores no code and returns none when the database will not take it", async () => {
    // A code we could not store is a code the claim will refuse, and a
    // learner typing it would conclude the feature is broken rather than
    // that it should be retried.
    dbFails = true;

    const res = await post("/api/v1/learners/me/link", {}, { token: issueToken(A) });
    const body = (await res.json()) as { code?: string; error?: { code: string } };

    expect(res.status).toBe(503);
    expect(body.code).toBeUndefined();
    expect(body.error?.code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("never writes the code into a log line", async () => {
    const { logger } = await import("../logger.js");

    const { code } = await mint(A);

    const written = JSON.stringify(
      [logger.info, logger.warn, logger.error, logger.debug].map((fn) => vi.mocked(fn).mock.calls),
    );
    expect(written).toContain("minted a device link code");
    for (const form of [code, code.replace("-", ""), code.toLowerCase()]) {
      expect(written).not.toContain(form);
    }
  });
});

describe("claiming it", () => {
  it("hands the new device a token for the same learner", async () => {
    const { code } = await mint(A);

    const res = await claim(code);
    const body = (await res.json()) as Claimed;

    expect(res.status).toBe(200);
    expect(body.learnerId).toBe(A);
    // Exactly what registration returns, so the client's existing path works.
    expect(body.token?.startsWith(`${A}.`)).toBe(true);
  });

  it("leaves the first device working, because this links rather than transfers", async () => {
    /**
     * The framing, asserted. "I bought a new phone" and "I also use a tablet"
     * are the same flow, and the merge layer combines the two records — so
     * invalidating the first device would be a data-loss feature wearing a
     * recovery feature's clothes.
     */
    const original = issueToken(A);
    const { code } = await mint(A);

    const claimed = (await (await claim(code)).json()) as Claimed;

    // Both credentials name the same learner, and the first one still works
    // on a route that requires one.
    expect(claimed.learnerId).toBe(A);
    expect((await post("/api/v1/learners/rotate", {}, { token: original })).status).toBe(200);
    expect((await post("/api/v1/learners/rotate", {}, { token: claimed.token })).status).toBe(200);
  });

  it("needs no credential of its own, which is the point", async () => {
    // The claiming device has none yet — if it had one it would not need to
    // link. So this route cannot sit behind requireLearner, and this says so.
    const { code } = await mint(A);

    expect((await claim(code)).status).toBe(200);
  });

  it("works once, and the second attempt is refused", async () => {
    const { code } = await mint(A);

    const first = await claim(code);
    const second = await claim(code);

    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
    expect(((await second.json()) as Claimed).token).toBeUndefined();
  });

  it("lets exactly one of two devices racing the same code in", async () => {
    /**
     * Two claims sent together, over HTTP. Honest about what it can prove:
     * whether the two handlers actually interleave here is up to the event
     * loop, so this is a smoke test that the second one loses rather than the
     * proof of atomicity. The guarantee itself is pinned in linkCodes.test.ts,
     * against a mock that mutates synchronously the way Mongo does — and a
     * read-then-write implementation fails there and passes here, which is
     * exactly why the claim is not made from this file.
     */
    const { code } = await mint(A);

    const [one, two] = await Promise.all([claim(code, address()), claim(code, address())]);

    const statuses = [one.status, two.status].sort();
    expect(statuses).toEqual([200, 401]);
  });

  it("refuses a code whose life has run out", async () => {
    const { code } = await mint(A);
    const row = rowFor(A);
    expect(row).toBeDefined();
    // Aged in the store rather than by waiting ten minutes. The route reads
    // the clock, so this is the honest way to reach the boundary.
    if (row !== undefined) row["expiresAt"] = new Date(Date.now() - 1_000);

    const res = await claim(code);

    expect(res.status).toBe(401);
  });

  it("answers an unknown code, a used one and an expired one identically", async () => {
    /**
     * The property a guesser would otherwise farm. Byte-for-byte the same
     * body and the same status, so a refusal cannot be read as "that code
     * exists but you are too late" — a fact about somebody else's account.
     */
    const used = await mint(A);
    await claim(used.code);

    const expired = await mint(B);
    const row = rowFor(B);
    if (row !== undefined) row["expiresAt"] = new Date(Date.now() - 1_000);

    const unknown = await claim("23456-789AB");
    const second = await claim(used.code);
    const late = await claim(expired.code);

    const bodies = await Promise.all([unknown.json(), second.json(), late.json()]);
    expect([unknown.status, second.status, late.status]).toEqual([401, 401, 401]);
    expect(JSON.stringify(bodies[1])).toBe(JSON.stringify(bodies[0]));
    expect(JSON.stringify(bodies[2])).toBe(JSON.stringify(bodies[0]));
  });

  it.each([
    ["missing", {}],
    ["not a string", { code: 42 }],
    ["a mongo operator", { code: { $ne: null } }],
    ["the wrong length", { code: "ABCDE-FGH" }],
    ["outside the alphabet", { code: "ABCDE-FGHJ0" }],
    ["enormous", { code: "A".repeat(100_000) }],
  ])("refuses a body whose code is %s", async (_label, body) => {
    const res = await post("/api/v1/learners/link/claim", body);

    // A distinct answer from the refusal above, and it discloses nothing: a
    // string of the wrong length or shape cannot be any code ever issued, so
    // this is about the caller's own typing.
    expect(res.status).toBe(400);
    expect(((await res.json()) as Claimed).error?.code).toBe("INVALID_REQUEST");
  });

  it("answers 400 rather than 500 for a body express.json() never parsed", async () => {
    // The bug registration and sync both had: reading through `req.body`
    // threw out of the handler and Express answered 500 with a stack trace,
    // on a route that exists to be called before anyone has a credential.
    const res = await fetch(`${base}/api/v1/learners/link/claim`, {
      method: "POST",
      headers: { "content-type": "text/plain", "x-forwarded-for": address() },
      body: "not json at all",
    });

    expect(res.status).toBe(400);
  });

  it("answers rather than hanging when the identity layer throws", async () => {
    /**
     * The floor under the fail-closed check.
     *
     * Everything in the identity layer *throws* rather than returning, so an
     * error escaping this handler leaves it having sent no response at all
     * and the claiming device waiting for its own timeout — not a 500, a
     * hang. Measured while breaking this on purpose: with the
     * `identityConfigured` guard removed, two assertions stopped failing fast
     * and started timing out after fifteen seconds.
     *
     * Reached here through a row whose learner id is not a learner id, which
     * `issueToken` refuses to sign. A build from before that field was
     * validated could have written one.
     */
    const { code } = await mint(A);
    const row = rowFor(A);
    if (row !== undefined) row["learnerId"] = "not-a-uuid";

    const res = await claim(code);
    const body = (await res.json()) as Claimed;

    expect(res.status).toBeLessThan(500);
    expect(body.token).toBeUndefined();
    expect(body.error?.code).toBe("INVALID_REQUEST");
  });

  it("says it could not check rather than that the code was wrong, on an outage", async () => {
    const { code } = await mint(A);
    dbFails = true;

    const res = await claim(code);

    expect(res.status).toBe(503);
    expect(((await res.json()) as Claimed).error?.code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("never writes the code into a log line, claimed or refused", async () => {
    const { logger } = await import("../logger.js");
    const { code } = await mint(A);
    vi.clearAllMocks();

    await claim(code);
    await claim(code);

    const written = JSON.stringify(
      [logger.info, logger.warn, logger.error, logger.debug].map((fn) => vi.mocked(fn).mock.calls),
    );
    expect(written).toContain("linked a device with a link code");
    for (const form of [code, code.replace("-", ""), code.toLowerCase()]) {
      expect(written).not.toContain(form);
    }
  });
});

describe("the ceiling on guessing", () => {
  it("cuts one address off after its tenth attempt", async () => {
    const from = "203.0.113.7";
    const statuses: number[] = [];

    for (let i = 0; i < limits.claimPerAddress + 2; i += 1) {
      statuses.push((await claim("23456-789AB", from)).status);
    }

    // Every attempt inside the budget is answered on its merits; everything
    // past it is refused without being checked at all.
    expect(statuses.slice(0, limits.claimPerAddress).every((status) => status === 401)).toBe(true);
    expect(statuses.slice(limits.claimPerAddress)).toEqual([429, 429]);
  });

  it("counts each address separately, so one guesser cannot lock out a learner", async () => {
    const from = "203.0.113.8";
    for (let i = 0; i < limits.claimPerAddress; i += 1) await claim("23456-789AB", from);
    expect((await claim("23456-789AB", from)).status).toBe(429);

    const { code } = await mint(A);

    expect((await claim(code, "203.0.113.9")).status).toBe(200);
  });

  it("is far tighter than the blanket diagnostics ceiling it replaces", async () => {
    // 120 a minute is right for a cheap read and wrong for a credential:
    // over a code's ten-minute life that would be 1,200 guesses from one
    // address instead of ten.
    expect(limits.claimPerAddress).toBeLessThan(120);
    expect(limits.claimPerAddress).toBeGreaterThan(2);
  });

  it("keeps a global budget as well, which is what a botnet cannot step around", async () => {
    /**
     * A per-address limit bounds one attacker and does nothing about ten
     * thousand addresses, which is the shape credential guessing actually
     * has. The global ceiling is the term that makes the arithmetic in
     * linkCodes.ts hold against an attacker of unbounded size — 600 wrong
     * codes a minute, everywhere, so about 6,600 guesses can be spent
     * against the whole service during any one code's life.
     */
    expect(limits.claimGlobal).toBeGreaterThan(limits.claimPerAddress);
    // The number the keyspace was chosen against. 6,600 guesses over
    // 5.9e14 possibilities is about 1.1e-11 per live code.
    const perCodeLife = limits.claimGlobal * 11;
    expect(perCodeLife / 590_490_000_000_000).toBeLessThan(1e-9);
  });

  it("bounds how fast one learner can churn codes", async () => {
    const token = issueToken(A);
    const statuses: number[] = [];

    for (let i = 0; i < limits.mintPerLearner + 1; i += 1) {
      statuses.push((await post("/api/v1/learners/me/link", {}, { token })).status);
    }

    expect(statuses.slice(0, limits.mintPerLearner).every((status) => status === 200)).toBe(true);
    expect(statuses[limits.mintPerLearner]).toBe(429);
  });

  it("counts minting per learner rather than per address, so a classroom is not one budget", async () => {
    for (let i = 0; i < limits.mintPerLearner; i += 1) {
      await post("/api/v1/learners/me/link", {}, { token: issueToken(A), from: "198.51.100.4" });
    }

    // Same address, different learner. A per-address mint limit would refuse
    // this, and twenty students behind one NAT would share five codes.
    const theirs = await post("/api/v1/learners/me/link", {}, { token: issueToken(B), from: "198.51.100.4" });

    expect(theirs.status).toBe(200);
  });
});

describe("with no secret configured", () => {
  beforeEach(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    await start(null);
  });

  it("refuses to mint rather than storing a digest keyed on nothing", async () => {
    const res = await post("/api/v1/learners/me/link", {}, { token: `${A}.1.forged` });

    // 503 rather than 401: nothing is wrong with the caller, and a 401 would
    // send the client off to register, which cannot work either.
    expect(res.status).toBe(503);
    expect(((await res.json()) as Claimed).error?.code).toBe("MISCONFIGURED");
  });

  it("refuses to claim, which it has to check for itself", async () => {
    /**
     * Every other learner route inherits this from `requireLearner`. This one
     * is unauthenticated by necessity and has no middleware to inherit it
     * from, so the check is in the handler — and if it were missing, the
     * endpoint would be the one door left open with identity switched off.
     */
    const res = await post("/api/v1/learners/link/claim", { code: "23456-789AB" });
    const body = (await res.json()) as Claimed;

    expect(res.status).toBe(503);
    expect(body.error?.code).toBe("MISCONFIGURED");
    expect(body.token).toBeUndefined();
  });

  it("issues no token even for a code shaped exactly like a real one", async () => {
    const res = await post("/api/v1/learners/link/claim", { code: "ABCDE-FGHJK" });

    expect(((await res.json()) as Claimed).token).toBeUndefined();
  });
});

describe("a deletion takes the codes with it", () => {
  it("leaves no row, and the code it handed out stops working", async () => {
    /**
     * The end of the credential's life, checked through the endpoints. A code
     * outliving the record it names is the worst leftover available: somebody
     * holding it could re-establish an identity the learner asked us to
     * destroy, and the record would start accumulating again under the same
     * id.
     */
    const token = issueToken(A);
    const { code } = await mint(A);
    expect(col("linkcodes").size).toBe(1);

    const deleted = await fetch(`${base}/api/v1/learners/me`, {
      method: "DELETE",
      headers: { "x-forwarded-for": address(), authorization: `Bearer ${token}` },
    });

    expect(deleted.status).toBe(200);
    expect(col("linkcodes").size).toBe(0);
    expect((await claim(code)).status).toBe(401);
  });

  it("takes nobody else's codes with it", async () => {
    const theirs = await mint(B);
    await mint(A);

    await fetch(`${base}/api/v1/learners/me`, {
      method: "DELETE",
      headers: { "x-forwarded-for": address(), authorization: `Bearer ${issueToken(A)}` },
    });

    expect((await claim(theirs.code)).status).toBe(200);
  });

  it("reports the deletion as incomplete rather than leaving a code behind", async () => {
    /**
     * The link codes are swept first and are allowed to fail the whole
     * request. Anything else in that sequence is a record; this one is a live
     * credential, and a deletion that quietly could not revoke it while
     * reporting success is the asterisk this project refuses to keep.
     */
    await mint(A);
    const token = issueToken(A);
    dbFails = true;

    const res = await fetch(`${base}/api/v1/learners/me`, {
      method: "DELETE",
      headers: { "x-forwarded-for": address(), authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(503);
    expect(((await res.json()) as Claimed).error?.code).toBe("PROVIDER_UNAVAILABLE");
  });
});
