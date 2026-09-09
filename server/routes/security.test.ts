/**
 * The security suite — the whole app, driven as an attacker rather than a client.
 *
 * Every other route test asks "does this feature work". This one asks the
 * questions a feature test never does: what happens when a field arrives with
 * the wrong *shape*, when a token is one byte wrong, when a caller adds a hop
 * to X-Forwarded-For, and when a valid token is pointed at somebody else's
 * record. Those are the failures that do not look like failures — nothing
 * throws, no screen breaks, and the wrong learner's data comes back.
 *
 * ── the seed ────────────────────────────────────────────────────────────────
 *
 * Express query parsing can turn `?learnerId[$ne]=x` into an **operator
 * object** rather than a string, and `{ learnerId: { $ne: "x" } }` as a Mongo
 * filter is every learner *but* one — out of endpoints whose entire purpose is
 * narrowing to a single one. Two measured facts shape how that is tested here:
 *
 *  - Express 5 defaults `query parser` to `simple`, so bracket notation is
 *    inert today: `req.query.learnerId` is `undefined` and the key arrives as
 *    the literal string `learnerId[$ne]`. Verified against express 5.2.1.
 *  - `?x=a&x=b` still arrives as an **array** under both parsers, and the
 *    object vector returns the moment anybody sets `extended`.
 *
 * So a guard has to be a predicate on the value's shape, never a `typeof`
 * test that an array satisfies — and the test has to hold under either
 * parser. Every case below therefore runs against **two apps**, one with the
 * default parser (exactly as index.ts leaves it) and one with `extended`.
 *
 * ── the invariant ───────────────────────────────────────────────────────────
 *
 * Stated once, asserted everywhere: **a narrowing field must never widen, and
 * nothing a caller sends may reach a Mongo filter.** The second half is
 * checked by taint: every hostile value carries a marker, the fake driver
 * records every filter it is handed, and no marker may appear in any of them.
 * That one assertion covers routes this file does not enumerate by name.
 *
 * Two substitutions, and only two: `getDb` (a live mongod would make the
 * suite non-idempotent) and the scoring vendor (a network and a bill). The
 * limiters, the identity chain, the merge readers and the body parser are all
 * the real thing.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Express } from "express";

/* ── the fake driver, with a record of every filter it was handed ────────── */

interface Doc {
  _id: string;
  learnerId?: string;
  version?: number;
  [key: string]: unknown;
}

let store: Map<string, Doc>;
/** Every filter any collection was queried or written with, this test. */
let queries: Array<{ collection: string; filter: unknown }>;
/** Every `.limit(n)` the routes asked for, so a clamp can be checked. */
let limits: number[];

function record<T>(collection: string, filter: T): T {
  queries.push({ collection, filter });
  return filter;
}

/**
 * The filters a *route* caused, excluding the limiters' own bookkeeping.
 *
 * `ratelimits` is written on the way in to every request, so leaving it in
 * would make "the store was never touched" impossible to assert. The taint
 * check below still covers it — a caller's value must not reach that
 * collection either.
 */
function routeFilters(): unknown[] {
  return queries.filter((q) => q.collection !== "ratelimits").map((q) => q.filter);
}

function matches(doc: Doc, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, want]) => {
    if (want !== null && typeof want === "object" && "$regex" in (want as object)) {
      return new RegExp(String((want as { $regex: unknown }).$regex)).test(String(doc[key]));
    }
    return doc[key] === want;
  });
}

function collect(name: string, filter: Record<string, unknown>): Doc[] {
  return [...store.entries()]
    .filter(([key, doc]) => key.startsWith(`${name}/`) && matches(doc, filter))
    .map(([, doc]) => structuredClone(doc));
}

function sorted(docs: Doc[], spec: Record<string, number>): Doc[] {
  const [field, direction] = Object.entries(spec)[0] ?? ["_id", 1];
  return [...docs].sort((a, b) => {
    const l = String(a[field ?? "_id"] ?? "");
    const r = String(b[field ?? "_id"] ?? "");
    return (l < r ? -1 : l > r ? 1 : 0) * (direction ?? 1);
  });
}

function applyUpdate(existing: Doc | undefined, id: string, update: Record<string, Record<string, unknown>>): Doc {
  const inc = update["$inc"] ?? {};
  const set = update["$set"] ?? {};
  const onInsert = existing === undefined ? (update["$setOnInsert"] ?? {}) : {};
  const base: Record<string, unknown> = existing ? { ...existing } : { _id: id, ...onInsert };
  for (const [key, by] of Object.entries(inc)) base[key] = ((base[key] as number) ?? 0) + (by as number);
  return { ...base, ...set } as Doc;
}

vi.mock("../db.js", () => ({
  getDb: () =>
    Promise.resolve({
      command: () => Promise.resolve({ ok: 1 }),
      collection: (name: string) => ({
        findOne: (f: Record<string, unknown>) =>
          Promise.resolve(structuredClone(collect(name, record(name, f))[0] ?? null)),
        find: (f: Record<string, unknown>) => {
          const found = () => collect(name, record(name, f));
          const chain = {
            sort: (spec: Record<string, number>) => ({
              limit: (n: number) => {
                limits.push(n);
                return { toArray: () => Promise.resolve(sorted(found(), spec).slice(0, n)) };
              },
              toArray: () => Promise.resolve(sorted(found(), spec)),
            }),
            limit: (n: number) => {
              limits.push(n);
              return { toArray: () => Promise.resolve(found().slice(0, n)) };
            },
            toArray: () => Promise.resolve(found()),
          };
          return chain;
        },
        insertOne: (doc: Doc) => {
          const id = doc._id ?? `generated-${String(store.size)}`;
          const key = `${name}/${id}`;
          if (doc._id !== undefined && store.has(key)) {
            const err = new Error("duplicate key") as Error & { code: number };
            err.code = 11000;
            return Promise.reject(err);
          }
          store.set(key, structuredClone({ ...doc, _id: id }));
          return Promise.resolve({ acknowledged: true });
        },
        updateOne: (
          f: { _id: string; version?: number },
          u: Record<string, Record<string, unknown>>,
          o?: { upsert?: boolean },
        ) => {
          record(name, f);
          const key = `${name}/${f._id}`;
          const existing = store.get(key);
          if (existing === undefined && o?.upsert !== true) {
            return Promise.resolve({ matchedCount: 0, acknowledged: true });
          }
          if (existing !== undefined && f.version !== undefined && existing.version !== f.version) {
            return Promise.resolve({ matchedCount: 0, acknowledged: true });
          }
          store.set(key, applyUpdate(existing, f._id, u));
          return Promise.resolve({ matchedCount: 1, acknowledged: true });
        },
        findOneAndUpdate: (f: { _id: string }, u: Record<string, Record<string, unknown>>) => {
          record(name, f);
          const key = `${name}/${f._id}`;
          const next = applyUpdate(store.get(key), f._id, u);
          store.set(key, next);
          return Promise.resolve(next);
        },
        deleteMany: (f: Record<string, unknown>) => {
          record(name, f);
          let deletedCount = 0;
          for (const [key, doc] of [...store.entries()]) {
            if (key.startsWith(`${name}/`) && matches(doc, f)) {
              store.delete(key);
              deletedCount += 1;
            }
          }
          return Promise.resolve({ acknowledged: true, deletedCount });
        },
        deleteOne: (f: { _id: string }) => {
          record(name, f);
          store.delete(`${name}/${f._id}`);
          return Promise.resolve({ acknowledged: true });
        },
        createIndex: () => Promise.resolve("ok"),
        aggregate: () => ({ toArray: () => Promise.resolve([{ allTime: [], today: [] }]) }),
      }),
    }),
}));

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../services/azureSpeech.js", () => ({
  AzureSpeechProvider: class {
    name = "azure";
    score() {
      return Promise.resolve({ indeterminate: true, provider: "azure", recognized: "", words: [] });
    }
  },
}));

/* ── taint ──────────────────────────────────────────────────────────────── */

/**
 * The marker every hostile value carries.
 *
 * Deliberately not a learner id, a slug or a number, so it can only ever have
 * come from a request body or query string — which is what makes finding it
 * inside a Mongo filter proof that a caller's value crossed the boundary.
 */
const TAINT = "T41NT-marker-value";

/** Deep search for the marker anywhere in a recorded filter. */
function mentionsTaint(value: unknown): boolean {
  if (typeof value === "string") return value.includes(TAINT);
  if (Array.isArray(value)) return value.some(mentionsTaint);
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(([key, inner]) => key.includes(TAINT) || mentionsTaint(inner));
  }
  return false;
}

/** True if any value we sent reached a query or an update filter. */
function taintReachedTheStore(): boolean {
  return queries.some((q) => mentionsTaint(q.filter));
}

/* ── the app, assembled as index.ts assembles it ────────────────────────── */

const SECRET = "security-suite-secret-not-a-real-one";
const DIAGNOSTICS_TOKEN = "security-suite-diagnostics-token";
const A = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const B = "11111111-2222-4333-8444-555555555555";

let simpleServer: Server;
let extendedServer: Server;
/** Keyed by parser, because every shape case runs against both. */
let bases: Record<Parser, string>;
let tokenFor: (id: string) => string;

type Parser = "simple" | "extended";

/** The two parsers, and what each makes of `?field[$op]=value`. */
const PARSERS: Parser[] = ["simple", "extended"];

interface Snapshot {
  progress: Array<{ slug: string; entries: Array<Record<string, unknown>> }>;
  skills: Array<{ slug: string; skills: Array<{ grapheme: string; samples: Array<{ at: string; accuracy: number }> }> }>;
  streak: { days: string[]; longest: number };
}

/**
 * One module graph, two apps.
 *
 * `vi.resetModules()` runs once, before either app is built, so both mount the
 * *same* router instances and the same identity module — which is what makes
 * `tokenFor` below trustworthy. A second `resetModules` between the two would
 * hand the second app a different `LEARNER_TOKEN_SECRET` reader than the one
 * that minted the tokens, and every 401 would be an artefact of the harness.
 */
async function boot(): Promise<Record<Parser, Express>> {
  process.env.LEARNER_TOKEN_SECRET = SECRET;
  process.env.DIAGNOSTICS_TOKEN = DIAGNOSTICS_TOKEN;
  process.env.MAX_DAILY_SCORING_CALLS = "100000";
  vi.resetModules();

  const express = (await import("express")).default;
  const { pronunciationRouter } = await import("./pronunciation.js");
  const { diagnosticsRouter } = await import("./diagnostics.js");
  const { learnersRouter } = await import("./learners.js");
  const { syncRouter } = await import("./sync.js");
  const { nextRouter } = await import("./next.js");
  const { contentRouter } = await import("./content.js");
  const { healthRouter } = await import("./health.js");
  const { issueToken } = await import("../identity.js");
  tokenFor = (id: string) => issueToken(id);

  const build = (parser: Parser): Express => {
    const app = express();
    // Exactly as index.ts sets it (NFR-04): one hop, so only the address the
    // real proxy appended is trusted.
    app.set("trust proxy", 1);
    // The default is `simple`, which is what index.ts leaves in place; the
    // second app opts into `extended` so the object vector is live.
    if (parser === "extended") app.set("query parser", "extended");
    app.use(express.json());
    app.use("/api/v1", pronunciationRouter);
    app.use("/api/v1", diagnosticsRouter);
    app.use("/api/v1", learnersRouter);
    app.use("/api/v1", syncRouter);
    app.use("/api/v1", nextRouter);
    app.use("/api/v1", contentRouter);
    app.use(healthRouter);
    return app;
  };

  return { simple: build("simple"), extended: build("extended") };
}

/** A distinct address per call, so the shared limiter is never what fails. */
function client(token?: string): Record<string, string> {
  const octet = (): number => Math.floor(Math.random() * 250);
  return {
    "x-forwarded-for": `10.${String(octet())}.${String(octet())}.${String(octet())}`,
    ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
  };
}

function json(token?: string): Record<string, string> {
  return { "content-type": "application/json", ...client(token) };
}

function operator(token?: string): Record<string, string> {
  return { "x-diagnostics-token": DIAGNOSTICS_TOKEN, ...client(token) };
}

beforeAll(async () => {
  store = new Map();
  queries = [];
  limits = [];
  const apps = await boot();
  await new Promise<void>((ready) => {
    simpleServer = apps.simple.listen(0, () => ready());
  });
  await new Promise<void>((ready) => {
    extendedServer = apps.extended.listen(0, () => ready());
  });
  bases = {
    simple: `http://127.0.0.1:${String((simpleServer.address() as AddressInfo).port)}`,
    extended: `http://127.0.0.1:${String((extendedServer.address() as AddressInfo).port)}`,
  };
});

afterAll(async () => {
  await new Promise<void>((done) => simpleServer.close(() => done()));
  await new Promise<void>((done) => extendedServer.close(() => done()));
  delete process.env.LEARNER_TOKEN_SECRET;
  delete process.env.DIAGNOSTICS_TOKEN;
  delete process.env.MAX_DAILY_SCORING_CALLS;
});

/**
 * A fresh store per test, so no case inherits a document another one wrote.
 *
 * This matters here more than in a feature suite: several cases assert that a
 * hostile push stored *nothing*, and a leftover document from an earlier case
 * would make that read as a pass or a fail for reasons unrelated to the guard
 * under test. It also resets the rate-limit windows, which is why every
 * limiter assertion accumulates its own counts inside a single test.
 */
afterEach(() => {
  store = new Map();
  queries = [];
  limits = [];
});

/* ── 1. every field is read as a shape, not as a type ───────────────────── */

describe.each(PARSERS)("under the %s query parser", (parser) => {
  const at = (path: string): string => `${bases[parser]}${path}`;

  /**
   * What each parser makes of `?field[$ne]=…`.
   *
   * `simple` yields `undefined` for the field (the key arrives as the literal
   * `field[$ne]`), which for a *narrowing* parameter reads as "no filter" —
   * correct, because it is the pre-existing unfiltered read rather than a
   * widened one. `extended` yields `{ $ne: … }`, which every guard here must
   * refuse outright. Both are stated rather than collapsed into an `||`, so a
   * regression under one parser cannot hide behind the other.
   */
  const objectVector = parser === "extended" ? "an operator object" : "an inert bracketed key";

  describe("the learner filter on the token-gated reads", () => {
    it.each(["/api/v1/attempts", "/api/v1/diagnostics"])(
      `refuses a repeated learnerId on %s, rather than passing an array to Mongo`,
      async (path) => {
        // Array under *both* parsers, which is why this is the vector that
        // matters today. `{ learnerId: ["a","b"] }` matches nothing, so it
        // would report "no records" for a learner who has plenty.
        const res = await fetch(at(`${path}?learnerId=${A}&learnerId=${B}`), { headers: operator() });

        expect(res.status).toBe(400);
        expect(taintReachedTheStore()).toBe(false);
        // Never the unfiltered read: a responder who asked about one person
        // must not silently be handed everyone.
        expect(routeFilters()).toEqual([]);
      },
    );

    it.each(["/api/v1/attempts", "/api/v1/diagnostics"])(
      `never lets ${objectVector} reach a query on %s`,
      async (path) => {
        const res = await fetch(at(`${path}?learnerId[$ne]=${TAINT}`), { headers: operator() });

        if (parser === "extended") {
          // `{ learnerId: { $ne: … } }` is every learner but one, out of a
          // narrowing endpoint. Refused before the store is touched.
          expect(res.status).toBe(400);
          expect(routeFilters()).toEqual([]);
        } else {
          // `undefined` reads as "no learner named", which is the unfiltered
          // read this endpoint has always served.
          expect(res.status).toBe(200);
          expect(routeFilters()).toEqual([{}]);
        }
        expect(taintReachedTheStore()).toBe(false);
      },
    );

    it.each(["/api/v1/attempts", "/api/v1/diagnostics"])(
      "refuses a learnerId that is a string but not a learner id on %s",
      async (path) => {
        const res = await fetch(at(`${path}?learnerId=${TAINT}`), { headers: operator() });

        expect(res.status).toBe(400);
        expect(taintReachedTheStore()).toBe(false);
      },
    );

    it("says what was wrong without echoing the value back", async () => {
      // Reflecting the input is how a diagnostics endpoint becomes an XSS
      // vector for whoever renders the error.
      const res = await fetch(at(`/api/v1/attempts?learnerId=${TAINT}`), { headers: operator() });
      const body = (await res.json()) as { error: string };

      expect(body.error).toMatch(/learnerId/);
      expect(body.error).not.toContain(TAINT);
    });
  });

  describe("the list limit on the token-gated reads", () => {
    it.each(["/api/v1/attempts", "/api/v1/diagnostics"])(
      "clamps %s so one request cannot pull the whole collection",
      async (path) => {
        const res = await fetch(at(`${path}?limit=100000`), { headers: operator() });

        expect(res.status).toBe(200);
        expect(limits).toEqual([200]);
      },
    );

    it.each(["/api/v1/attempts", "/api/v1/diagnostics"])(
      `falls back to the default rather than an unbounded read for ${objectVector} on %s`,
      async (path) => {
        // `Number({ $gt: "0" })` and `Number(["1","2"])` are both NaN. The
        // failure to guard here would be `limit: NaN`, which the driver reads
        // as no limit at all.
        const res = await fetch(at(`${path}?limit[$gt]=0&limit=1&limit=2`), { headers: operator() });

        expect(res.status).toBe(200);
        expect(limits).toEqual([50]);
      },
    );
  });

  describe("the language on /next", () => {
    it(`refuses ${objectVector} in place of a slug`, async () => {
      const res = await fetch(at(`/api/v1/next?slug[$ne]=${TAINT}`), { headers: client(tokenFor(A)) });

      // 400 under both parsers: `undefined` is not a slug either, and a slug
      // is required rather than optional.
      expect(res.status).toBe(400);
      expect(taintReachedTheStore()).toBe(false);
    });

    it("refuses a repeated slug rather than keying a document on an array", async () => {
      const res = await fetch(at("/api/v1/next?slug=fr&slug=de"), { headers: client(tokenFor(A)) });

      expect(res.status).toBe(400);
    });

    it("refuses a slug that would escape its own document id", async () => {
      const res = await fetch(at("/api/v1/next?slug=../../etc/passwd"), { headers: client(tokenFor(A)) });

      expect(res.status).toBe(400);
    });

    it("does not echo the slug back into the refusal", async () => {
      const res = await fetch(at(`/api/v1/next?slug=${TAINT}`), { headers: client(tokenFor(A)) });
      const body = (await res.json()) as { error: { message: string; userMessage: string } };

      expect(res.status).toBe(400);
      expect(JSON.stringify(body)).not.toContain(TAINT);
    });
  });

  describe("the language in a content path", () => {
    it.each([
      ["a traversal", "..%2F..%2Fetc"],
      ["an operator as a path segment", "%24ne"],
      ["an over-long value", "a".repeat(64)],
    ])("refuses %s before it reaches a document id", async (_label, slug) => {
      const res = await fetch(at(`/api/v1/content/${slug}`), { headers: client() });

      expect(res.status).toBe(400);
      expect(routeFilters()).toEqual([]);
    });

    it("refuses a version that is not a whole number", async () => {
      const res = await fetch(at(`/api/v1/content/fr/versions/${TAINT}`), { headers: operator() });

      expect(res.status).toBe(400);
      expect(taintReachedTheStore()).toBe(false);
    });
  });

  describe("bodies", () => {
    it("refuses an operator object where a learner id belongs", async () => {
      const res = await fetch(at("/api/v1/learners"), {
        method: "POST",
        headers: json(),
        body: JSON.stringify({ learnerId: { $ne: TAINT } }),
      });

      expect(res.status).toBe(400);
      expect(taintReachedTheStore()).toBe(false);
    });

    it("refuses an array where a learner id belongs", async () => {
      const res = await fetch(at("/api/v1/learners"), {
        method: "POST",
        headers: json(),
        body: JSON.stringify({ learnerId: [A] }),
      });

      expect(res.status).toBe(400);
    });

    it("issues no token for an id it refused", async () => {
      // A token is the credential. Signing a shape that is not an id would
      // make the token a carrier for whatever the caller sent.
      const res = await fetch(at("/api/v1/learners"), {
        method: "POST",
        headers: json(),
        body: JSON.stringify({ learnerId: { $ne: TAINT } }),
      });
      const body = (await res.json()) as { token?: string };

      expect(body.token).toBeUndefined();
    });

    it("drops a name and a locale that are not strings, rather than storing them", async () => {
      const res = await fetch(at("/api/v1/learners"), {
        method: "POST",
        headers: json(),
        body: JSON.stringify({ learnerId: A, displayName: { $ne: TAINT }, locale: [TAINT] }),
      });

      expect(res.status).toBe(200);
      // The write is fire-and-forget, so give it a turn to land before the
      // store is inspected.
      await new Promise((settle) => setTimeout(settle, 20));
      expect(JSON.stringify([...store.values()])).not.toContain(TAINT);
    });

    it("drops a synced language whose slug is an operator object", async () => {
      const res = await fetch(at("/api/v1/sync"), {
        method: "POST",
        headers: json(tokenFor(A)),
        body: JSON.stringify({
          progress: [{ slug: { $ne: TAINT }, entries: [entry()] }],
          skills: [{ slug: { $ne: TAINT }, skills: [skill()] }],
        }),
      });
      const body = (await res.json()) as Snapshot;

      expect(res.status).toBe(200);
      expect(body.progress).toEqual([]);
      expect(body.skills).toEqual([]);
      expect(taintReachedTheStore()).toBe(false);
    });

    it("drops a syllable whose name is an operator object", async () => {
      const res = await fetch(at("/api/v1/sync"), {
        method: "POST",
        headers: json(tokenFor(A)),
        body: JSON.stringify({
          skills: [{ slug: "fr", skills: [{ grapheme: { $ne: TAINT }, samples: [{ at: "2026-09-07T10:00:00.000Z", accuracy: 50 }] }] }],
        }),
      });
      const body = (await res.json()) as Snapshot;

      expect(res.status).toBe(200);
      expect(body.skills.flatMap((s) => s.skills)).toEqual([]);
      expect(taintReachedTheStore()).toBe(false);
    });

    it("drops a practice day list that is an operator object", async () => {
      const res = await fetch(at("/api/v1/sync"), {
        method: "POST",
        headers: json(tokenFor(A)),
        body: JSON.stringify({ streak: { days: { $ne: TAINT }, longest: { $gt: 1 } } }),
      });

      expect(res.status).toBe(200);
      expect(taintReachedTheStore()).toBe(false);
    });

    it("refuses a baseVersion that is not a number, rather than coercing it", async () => {
      const res = await fetch(at("/api/v1/content/fr"), {
        method: "POST",
        headers: { ...operator(), "content-type": "application/json" },
        body: JSON.stringify({ baseVersion: { $gt: 0 }, code: "fr-FR", label: TAINT, activities: [] }),
      });

      expect(res.status).toBe(400);
      expect(taintReachedTheStore()).toBe(false);
    });

    it("records a diagnostic with safe defaults rather than storing an operator", async () => {
      // Deliberately lenient — a dropped diagnostic is worse than one filed
      // as UNKNOWN — so the assertion is about what is *stored*, not the code.
      const res = await fetch(at("/api/v1/diagnostics"), {
        method: "POST",
        headers: json(),
        body: JSON.stringify({ code: { $ne: TAINT }, message: { $ne: TAINT } }),
      });

      expect(res.status).toBe(204);
      await new Promise((settle) => setTimeout(settle, 20));
      expect(taintReachedTheStore()).toBe(false);
    });
  });

  describe("the header that carries the credential", () => {
    it("refuses a bare learner id in place of a token", async () => {
      expect((await fetch(at("/api/v1/sync"), { headers: client(A) })).status).toBe(401);
    });

    it("refuses a duplicated diagnostics token header", async () => {
      // Node joins repeated headers with ", ", so this arrives as a string
      // that is not the token — it must not be split and re-tried.
      const res = await fetch(at("/api/v1/attempts"), {
        headers: [
          ["x-diagnostics-token", DIAGNOSTICS_TOKEN],
          ["x-diagnostics-token", DIAGNOSTICS_TOKEN],
          ...Object.entries(client()),
        ],
      });

      expect(res.status).toBe(401);
    });

    it("refuses a duplicated authorization header", async () => {
      const res = await fetch(at("/api/v1/sync"), {
        headers: [
          ["authorization", `Bearer ${tokenFor(A)}`],
          ["authorization", `Bearer ${tokenFor(A)}`],
          ...Object.entries(client()),
        ],
      });

      expect(res.status).toBe(401);
    });

    it("still gates a path reached with different capitalisation", async () => {
      // Express routes case-insensitively, so a guard mounted per route has to
      // apply to `/API/V1/…` as well — the classic shape of an auth bypass.
      expect((await fetch(at("/API/V1/attempts"), { headers: client() })).status).toBe(401);
    });

    it("still gates a path reached with a trailing slash", async () => {
      expect((await fetch(at("/api/v1/attempts/"), { headers: client() })).status).toBe(401);
    });
  });
});

/* ── 2. one token reaches exactly one learner's record ──────────────────── */

/**
 * The highest-value block on the page.
 *
 * Two learners on one device previously collided into a single server identity
 * and pooled their records — shared streak days and, worse, sound histories
 * across two different accents, which is the one measurement this product
 * exists to make. Nothing looked broken; every screen showed a plausible
 * trend computed from somebody else's voice.
 *
 * So the property is not "the routes have auth". It is that **no field a
 * caller controls can move a request onto another learner's record**, and the
 * cases below try every field there is: a body id, a query id, a second
 * device, a deletion.
 */
describe("a learner token reaches exactly one learner's record", () => {
  const at = (path: string): string => `${bases.simple}${path}`;

  async function push(body: unknown, token: string): Promise<Snapshot> {
    const res = await fetch(at("/api/v1/sync"), { method: "POST", headers: json(token), body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    return (await res.json()) as Snapshot;
  }

  async function pull(token: string, query = ""): Promise<Snapshot> {
    const res = await fetch(at(`/api/v1/sync${query}`), { headers: client(token) });
    expect(res.status).toBe(200);
    return (await res.json()) as Snapshot;
  }

  it("ignores a learner id in the push body", async () => {
    // The only learner on a request is the one the signature names. A body
    // field that could redirect the write is the whole vulnerability.
    await push({ learnerId: B, streak: { days: ["2026-09-01"], longest: 1 } }, tokenFor(A));

    expect((await pull(tokenFor(B))).streak.days).toEqual([]);
    expect((await pull(tokenFor(A))).streak.days).toEqual(["2026-09-01"]);
  });

  it("ignores a learner id in the pull query", async () => {
    await push({ streak: { days: ["2026-09-02"], longest: 1 } }, tokenFor(B));

    const mine = await pull(tokenFor(A), `?learnerId=${B}`);

    expect(mine.streak.days).not.toContain("2026-09-02");
  });

  it("keeps two learners on one device apart, including their sound histories", async () => {
    /**
     * The regression this block exists for. Both requests come from the same
     * address with the same user agent — one shared tablet — and differ only
     * in which signed id they carry.
     */
    const device = { "x-forwarded-for": "203.0.113.9", "content-type": "application/json" };
    const send = async (token: string, grapheme: string): Promise<void> => {
      const res = await fetch(at("/api/v1/sync"), {
        method: "POST",
        headers: { ...device, authorization: `Bearer ${token}` },
        body: JSON.stringify({
          skills: [{ slug: "fr", skills: [{ grapheme, samples: [{ at: "2026-09-03T10:00:00.000Z", accuracy: 40 }] }] }],
        }),
      });
      expect(res.status).toBe(200);
    };

    await send(tokenFor(A), "ment");
    await send(tokenFor(B), "eux");

    const mine = (await pull(tokenFor(A))).skills.flatMap((s) => s.skills.map((k) => k.grapheme));
    const theirs = (await pull(tokenFor(B))).skills.flatMap((s) => s.skills.map((k) => k.grapheme));

    expect(mine).toEqual(["ment"]);
    expect(theirs).toEqual(["eux"]);
  });

  it.each([
    ["with nothing to point it elsewhere", ""],
    // `/learners/me` takes no parameters — which is exactly why a handler
    // that started honouring one would go unnoticed. Both spellings are
    // tried, because "me" is only "me" while nothing can override it.
    ["asked for somebody else by query", `?learnerId=${B}`],
    ["asked for somebody else by an aliased query", `?learner=${B}&id=${B}&learnerId=${B}`],
  ])("exports nobody else's record, %s", async (_label, query) => {
    await push({ streak: { days: ["2026-09-04"], longest: 1 } }, tokenFor(B));

    const res = await fetch(at(`/api/v1/learners/me/export${query}`), { headers: client(tokenFor(A)) });
    const body = (await res.json()) as { learnerId: string; collections: { streaks: unknown } };

    expect(res.status).toBe(200);
    expect(body.learnerId).toBe(A);
    expect(JSON.stringify(body)).not.toContain("2026-09-04");
    expect(JSON.stringify(body)).not.toContain(B);
  });

  it.each([
    ["with nothing to point it elsewhere", ""],
    // The most destructive route in the product, so the same override attempt
    // is made here as on the export.
    ["asked to erase somebody else", `?learnerId=${B}`],
  ])("erases nobody else's record, %s", async (_label, query) => {
    await push({ streak: { days: ["2026-09-05"], longest: 1 } }, tokenFor(B));
    await push({ streak: { days: ["2026-09-06"], longest: 1 } }, tokenFor(A));

    const res = await fetch(at(`/api/v1/learners/me${query}`), {
      method: "DELETE",
      headers: { ...client(tokenFor(A)), "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect((await pull(tokenFor(B))).streak.days).toContain("2026-09-05");
    expect((await pull(tokenFor(A))).streak.days).not.toContain("2026-09-06");
  });

  it("reads nobody else's schedule from /next", async () => {
    await push(
      { skills: [{ slug: "de", skills: [{ grapheme: "chen", samples: [{ at: "2026-09-07T10:00:00.000Z", accuracy: 30 }] }] }] },
      tokenFor(B),
    );

    const res = await fetch(at("/api/v1/next?slug=de"), { headers: client(tokenFor(A)) });
    const body = (await res.json()) as { all: Array<{ grapheme: string }> };

    expect(res.status).toBe(200);
    expect(body.all).toEqual([]);
  });

  it("rotates a token to the same learner, never to another one", async () => {
    // Rotation is the one route that *mints* a credential from an existing
    // one, so a body or query that could steer it would be a free upgrade
    // from "a token for me" to "a token for anyone".
    const res = await fetch(at(`/api/v1/learners/rotate?learnerId=${B}`), {
      method: "POST",
      headers: json(tokenFor(A)),
      body: JSON.stringify({ learnerId: B }),
    });
    const body = (await res.json()) as { token: string };

    expect(res.status).toBe(200);
    expect(body.token.split(".")[0]).toBe(A);
  });

  /**
   * ⚠ REPORTED WEAKNESS — the boundary above holds, but only as far as the id
   * stays secret. See server/routes/learners.ts:81-123.
   *
   * `POST /api/v1/learners` signs whatever well-formed id it is handed, with
   * no proof that the caller is that learner and no check that the id is
   * already in use. So anybody who learns another learner's UUID can trade it
   * for a valid token in one unauthenticated request, and then do everything
   * the cases above prove a *stranger's* token cannot: read the export, pull
   * and overwrite the record, delete it.
   *
   * That contradicts what two files claim in prose. identity.ts:5-13 says the
   * bare id "would let a caller read or overwrite another learner's progress
   * just by guessing" and that signing closes it; learnerId.ts:15-18 says the
   * id "is also not a credential on its own". Neither is true while this route
   * mints a token for any id — the signature is a rubber stamp on the caller's
   * own claim, and the id *is* the credential.
   *
   * It is not an oversight to delete, either: tokenStore.ts:8-11 depends on
   * this idempotency ("losing the token costs a round trip rather than an
   * identity"), and engine.ts:108-116 clears the token on a 401 while keeping
   * the id, so a secret rotation would otherwise strand every learner. The
   * fix is a design decision, not a one-liner — which is why this test pins
   * the behaviour rather than asserting a property nobody has chosen yet.
   *
   * What makes it survivable today is entropy, not authorisation: the id is
   * 122 random bits from `crypto.getRandomValues` (src/lib/uuid.ts), so it
   * cannot be guessed. The next test is the other half — that nothing hands
   * one out.
   */
  it("signs any id it is handed, so the id and not the token is what a takeover needs", async () => {
    await push({ streak: { days: ["2026-09-08"], longest: 1 } }, tokenFor(B));

    // An attacker who knows B's id, with no token and no prior request.
    const minted = await fetch(at("/api/v1/learners"), {
      method: "POST",
      headers: json(),
      body: JSON.stringify({ learnerId: B }),
    });
    const { token } = (await minted.json()) as { token: string };

    expect(minted.status).toBe(200);
    // The token names B, and it works on B's record.
    expect(token.split(".")[0]).toBe(B);
    expect((await pull(token)).streak.days).toEqual(["2026-09-08"]);
  });

  it("hands a learner id to nobody who does not already have it", async () => {
    /**
     * The other half of the weakness above, and the part that has to hold: an
     * id that cannot be guessed is only safe while nothing publishes one. So
     * no response to an unauthenticated caller may carry a learner id —
     * including the refusals, which is where a reflected value would show up.
     */
    await push({ streak: { days: ["2026-09-09"], longest: 1 } }, tokenFor(B));

    const responses = await Promise.all([
      fetch(at("/api/v1/content/fr"), { headers: client() }),
      fetch(at("/api/v1/attempts"), { headers: client() }),
      fetch(at("/api/v1/diagnostics"), { headers: client() }),
      fetch(at("/api/v1/sync"), { headers: client() }),
      fetch(at("/api/v1/next?slug=fr"), { headers: client() }),
      fetch(at("/metrics"), { headers: client() }),
      fetch(at("/readyz"), { headers: client() }),
      fetch(at("/api/v1/learners"), { method: "POST", headers: json(), body: JSON.stringify({ learnerId: B, displayName: B }) }),
    ]);
    const bodies = await Promise.all(responses.map(async (res) => res.text()));

    // The registration call is the exception by construction: it is the caller
    // telling the server an id it already holds, so it appears in the token it
    // gets back. Every other surface must be silent about who exists.
    for (const body of bodies.slice(0, -1)) {
      expect(body).not.toContain(B);
      expect(body).not.toContain(A);
    }
  });
});

/* ── 3. the credential is compared whole ────────────────────────────────── */

/**
 * `verifyToken` compares HMACs with `timingSafeEqual`, having checked the
 * lengths first (the function throws on a length mismatch rather than
 * returning false, and the digest length is fixed and public, so
 * short-circuiting on it leaks nothing).
 *
 * The byte-position sweep and the comparator itself are pinned in
 * identity.timing.test.ts. What is asserted here is the property at the HTTP
 * boundary: a caller learns *nothing* about which half of a guess was right —
 * not from the status, not from the body, and not from a distinct code path
 * for a wrong length.
 */
describe("a wrong token tells the caller nothing about how wrong it was", () => {
  const at = (path: string): string => `${bases.simple}${path}`;

  function variants(): Array<[string, string]> {
    const good = tokenFor(A);
    const [id, issued, signature] = good.split(".") as [string, string, string];
    const flip = (char: string): string => (char === "A" ? "B" : "A");
    return [
      ["a signature wrong in its first byte", `${id}.${issued}.${flip(signature[0] ?? "A")}${signature.slice(1)}`],
      ["a signature wrong in its last byte", `${id}.${issued}.${signature.slice(0, -1)}${flip(signature.slice(-1))}`],
      ["a signature one byte short", `${id}.${issued}.${signature.slice(0, -1)}`],
      ["a signature far too long", `${id}.${issued}.${signature}${signature}`],
      ["no signature at all", `${id}.${issued}.`],
      ["an expired-looking payload with a forged signature", `${id}.1.${signature}`],
    ];
  }

  it("answers every near-miss with the same status and the same body", async () => {
    const answers = await Promise.all(
      variants().map(async ([, token]) => {
        const res = await fetch(at("/api/v1/sync"), { headers: client(token) });
        return `${String(res.status)} ${await res.text()}`;
      }),
    );

    // One distinct answer across every variant. A wrong length taking a
    // different path, or an expiry check running before the signature, would
    // show up here as a second string.
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toMatch(/^401 /);
  });

  it("never says which check failed", async () => {
    const res = await fetch(at("/api/v1/sync"), { headers: client(`${A}.1.nonsense`) });
    const body = await res.text();

    // "expired" versus "bad signature" tells an attacker which half of a
    // guess was right, and the client does the same thing either way.
    expect(body).not.toMatch(/expired|signature|malformed|hmac/i);
  });

  it("never crashes on a wrong-length signature", async () => {
    // timingSafeEqual throws on a length mismatch. Without the length check in
    // front of it this would be a 500 out of the authentication path.
    const res = await fetch(at("/api/v1/sync"), { headers: client(`${A}.${String(Date.now())}.x`) });

    expect(res.status).toBe(401);
  });
});

/* ── 4. the rate limits cannot be shrugged off ──────────────────────────── */

/**
 * The scoring endpoint is an open proxy to a metered API, so the limiters are
 * the bill. Three bypasses are worth trying, and each is checked from the
 * `RateLimit-*` headers rather than by exhausting a window — a fixed window
 * floored to the minute makes an exhaustion test a coin flip on where the
 * suite happens to start.
 */
describe("the rate limits cannot be shrugged off", () => {
  const at = (path: string): string => `${bases.simple}${path}`;

  async function limitFor(headers: Record<string, string>): Promise<{ limit: string | null; remaining: string | null }> {
    const res = await fetch(at("/api/v1/pronunciation"), { method: "POST", headers });
    return { limit: res.headers.get("ratelimit-limit"), remaining: res.headers.get("ratelimit-remaining") };
  }

  it("counts extra X-Forwarded-For hops into one bucket", async () => {
    /**
     * `trust proxy` is 1, so only the address the real proxy appended is
     * trusted and everything to its left is the caller's own invention.
     *
     * Three requests, three *different* invented left-hand hops, one real
     * right-hand one. Under `trust proxy: 1` all three land in the bucket for
     * 192.0.2.77 and the remaining count falls; set to `true` — the one-word
     * edit NFR-04 exists to prevent — Express would read the leftmost entry
     * instead, each request would open its own bucket, and all three would
     * report the same remaining count. So the discriminator is that the count
     * *moves*, by the same step each time.
     */
    const remaining: number[] = [];
    for (const spoofed of ["198.51.100.1", "198.51.100.2", "198.51.100.3"]) {
      const res = await fetch(at("/api/v1/content/fr"), {
        headers: { "x-forwarded-for": `${spoofed}, 192.0.2.77` },
      });
      remaining.push(Number(res.headers.get("ratelimit-remaining")));
    }

    const [first, second, third] = remaining as [number, number, number];
    const step = first - second;
    expect(step).toBeGreaterThan(0);
    expect(second - third).toBe(step);
  });

  it("does not let an invalid token buy the identified caller's path", async () => {
    // The per-IP limiter skips a request that carries a *valid* token. An
    // invalid one must leave the caller anonymous and inside the shared
    // ceiling, or forging a token would be the cheapest bypass there is.
    const anonymous = await limitFor(client());
    const forged = await limitFor(client(`${A}.${String(Date.now())}.forged`));

    expect(anonymous.limit).toBe("30");
    expect(forged.limit).toBe("30");
  });

  it("moves an identified learner onto their own tighter budget", async () => {
    const identified = await limitFor(client(tokenFor(A)));

    // Twenty, from perLearnerScoringLimiter — not the looser shared 30.
    expect(identified.limit).toBe("20");
  });

  it("follows a learner between addresses rather than resetting per network", async () => {
    // Keyed on the learner, so moving from wifi to cellular is not a fresh
    // budget. Two requests, two addresses, one count.
    const first = await limitFor(client(tokenFor(B)));
    const second = await limitFor(client(tokenFor(B)));

    expect(Number(second.remaining)).toBe(Number(first.remaining) - 1);
  });

  it("keeps two learners' budgets separate", async () => {
    // One learner spends three of their twenty from a single address.
    const shared = client(tokenFor(A));
    await limitFor(shared);
    await limitFor(shared);
    const a = await limitFor(shared);

    // A second learner on that same address starts at their own ceiling
    // rather than inheriting the count — the classroom-behind-one-NAT case
    // the per-learner limiter exists for.
    const b = await limitFor({ ...shared, authorization: `Bearer ${tokenFor("22222222-3333-4444-8555-666666666666")}` });

    expect(Number(a.remaining)).toBe(17);
    expect(Number(b.remaining)).toBe(19);
  });
});

/* ── 5. malformed and oversized bodies ──────────────────────────────────── */

describe("malformed and oversized bodies", () => {
  const at = (path: string): string => `${bases.simple}${path}`;

  const WRITES: Array<[string, string, Record<string, string>]> = [
    ["/api/v1/sync", "POST", {}],
    ["/api/v1/learners", "POST", {}],
    ["/api/v1/diagnostics", "POST", {}],
    ["/api/v1/content/fr", "POST", { "x-diagnostics-token": DIAGNOSTICS_TOKEN }],
  ];

  it.each(WRITES)("answers 413 rather than reading an oversized body on %s", async (path, method, extra) => {
    // express.json()'s default ceiling is 100kb. Without one, a body is an
    // unbounded allocation per request.
    const body = JSON.stringify({ pad: "x".repeat(200_000) });
    const res = await fetch(at(path), { method, headers: { ...json(tokenFor(A)), ...extra }, body });

    expect(res.status).toBe(413);
  });

  it.each(WRITES)("answers 400 rather than crashing on malformed JSON on %s", async (path, method, extra) => {
    const res = await fetch(at(path), {
      method,
      headers: { ...json(tokenFor(A)), ...extra },
      body: '{"progress":[',
    });

    expect(res.status).toBe(400);
  });

  it("survives a JSON array where an object was expected", async () => {
    const res = await fetch(at("/api/v1/sync"), { method: "POST", headers: json(tokenFor(A)), body: "[1,2,3]" });

    expect(res.status).toBe(200);
  });

  it("survives a JSON scalar where an object was expected", async () => {
    const res = await fetch(at("/api/v1/content/fr"), {
      method: "POST",
      headers: { ...json(), "x-diagnostics-token": DIAGNOSTICS_TOKEN },
      body: "42",
    });

    expect(res.status).toBe(400);
  });

  it("bounds how many languages one push can enqueue", async () => {
    // Each language is a read-modify-write with retries, which makes an
    // unbounded list the cheapest denial of service against this endpoint.
    const many = Array.from({ length: 200 }, (_, i) => ({
      slug: `l${String.fromCharCode(97 + (i % 26))}`,
      entries: [entry()],
    }));

    const res = await fetch(at("/api/v1/sync"), {
      method: "POST",
      headers: json(tokenFor("33333333-4444-4555-8666-777777777777")),
      body: JSON.stringify({ progress: many }),
    });
    const body = (await res.json()) as Snapshot;

    expect(body.progress.length).toBeLessThanOrEqual(12);
  });

  it("bounds how many entries one language can store", async () => {
    const entries = Array.from({ length: 500 }, (_, i) => entry({ activityId: i }));

    const res = await fetch(at("/api/v1/sync"), {
      method: "POST",
      headers: json(tokenFor("44444444-5555-4666-8777-888888888888")),
      body: JSON.stringify({ progress: [{ slug: "fr", entries }] }),
    });
    const body = (await res.json()) as Snapshot;

    expect(body.progress[0]?.entries.length).toBeLessThanOrEqual(200);
  });

  /**
   * ⚠ REPORTED DEFECT — server/routes/sync.ts:103 and server/routes/learners.ts:82.
   *
   * `req.body` is `undefined` whenever `express.json()` did not run: a request
   * whose Content-Type is anything but application/json, or one with no body
   * at all. Both handlers then reach straight into it —
   * `const body = req.body as {...}` followed by `body.progress` /
   * `body.learnerId` — and throw `TypeError: Cannot read properties of
   * undefined`. Express's default handler turns that into a **500 carrying the
   * exception message and a full stack trace** (absolute source paths
   * included), because the app installs no error middleware and `app.set("env")`
   * is only "production" if NODE_ENV says so — `npm start` does not set it.
   *
   * Two things wrong: a client's mistake is reported as a server fault, and
   * R2's "no branch of this ever includes internal detail" — which
   * pronunciation.ts maintains carefully — is broken by the one path that
   * bypasses every handler. It is also a free log-flooding vector: one
   * `logger.error` per malformed request, unauthenticated.
   *
   * `content.ts` shows the one-line shape of the fix
   * (`typeof req.body === "object" && req.body !== null ? … : {}`), and
   * `diagnostics.ts` gets it for free from `safeParse`.
   *
   * Written with `it.fails` rather than weakened to assert the 500: the
   * expectation below is the correct one, so the day somebody guards those two
   * reads this test goes red and is promoted to a plain `it`. Verified in both
   * directions — with the `content.ts` guard applied to these two handlers,
   * both cases here go green (sync answers 200 for an empty push, learners a
   * 400 for a missing id) and the `it.fails` is what fails.
   *
   * Deliberately "not a server error" rather than "exactly 400", because
   * which 4xx is right differs per route and is not the part that is broken.
   */
  it.fails.each([
    ["/api/v1/sync", "POST"],
    ["/api/v1/learners", "POST"],
  ])("does not answer a 5xx for a body express.json() never parsed on %s", async (path, method) => {
    const res = await fetch(at(path), {
      method,
      headers: { "content-type": "text/plain", ...client(tokenFor(A)) },
      body: "not json at all",
    });

    expect(res.status).toBeLessThan(500);
  });

  it.fails("never returns a stack trace or a source path to the caller", async () => {
    // Same defect, and the half that matters for R2. The response body carries
    // the exception message, the file, the line, and every frame above it.
    const res = await fetch(at("/api/v1/sync"), {
      method: "POST",
      headers: { "content-type": "text/plain", ...client(tokenFor(A)) },
      body: "not json at all",
    });
    const body = await res.text();

    expect(body).not.toMatch(/TypeError|\.ts:\d+|node_modules/);
  });
});

/* ── fixtures ───────────────────────────────────────────────────────────── */

function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
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

function skill(): Record<string, unknown> {
  return { grapheme: "ment", samples: [{ at: "2026-09-07T10:00:00.000Z", accuracy: 61 }] };
}
