/**
 * What the app does with each secret missing.
 *
 * The rule the product states in three places — identity.ts:31-38,
 * diagnostics.ts:10-15, content.ts:34-38 — is that there is **no "unset means
 * open"**. A forgotten environment variable must never be the difference
 * between an internal screen and a public export of every learner's spoken
 * phrases, and it must never be the difference between a signed token and an
 * unsigned one anybody can forge.
 *
 * That rule is worth its own file for one reason: it is the assertion easiest
 * to fake. `LEARNER_TOKEN_SECRET` is read **once, at module load**, so a test
 * that sets it inside a nested `beforeAll` configures a *different* module
 * instance than the app it then calls — four false passes in this repo's
 * history came from exactly that. So every case here is built to prove the
 * decision and the assertion come from the same instance:
 *
 *  - For the token secret, `GET /readyz` reports `identityConfigured()` from
 *    the very module graph the app's `requireLearner` reads it from. Each
 *    case asserts that flag *first*, and only then the refusal. A harness that
 *    had configured the wrong instance would fail on the flag.
 *  - For `DIAGNOSTICS_TOKEN`, which is read per request, the same running
 *    instance is walked through unset → empty → set and back, and its answers
 *    change accordingly. Nothing else can explain that but the app reading the
 *    environment this test is editing.
 *
 * The other half of "fail closed" is that it must not mean "fail". Identity is
 * optional by design — a learner who has never registered has to be able to
 * practise — so the routes behind `optionalLearner` are asserted to still
 * serve anonymous callers with no secret at all.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

let touched: string[];

vi.mock("../db.js", () => ({
  getDb: () =>
    Promise.resolve({
      command: () => Promise.resolve({ ok: 1 }),
      collection: (name: string) => {
        touched.push(name);
        return {
          findOne: () => Promise.resolve(null),
          find: () => ({
            sort: () => ({ limit: () => ({ toArray: () => Promise.resolve([]) }), toArray: () => Promise.resolve([]) }),
            limit: () => ({ toArray: () => Promise.resolve([]) }),
            toArray: () => Promise.resolve([]),
          }),
          insertOne: () => Promise.resolve({ acknowledged: true }),
          updateOne: () => Promise.resolve({ matchedCount: 1, acknowledged: true }),
          findOneAndUpdate: (f: { _id: string }) => Promise.resolve({ _id: f._id, hits: 1 }),
          deleteMany: () => Promise.resolve({ acknowledged: true, deletedCount: 0 }),
          deleteOne: () => Promise.resolve({ acknowledged: true }),
          createIndex: () => Promise.resolve("ok"),
          aggregate: () => ({ toArray: () => Promise.resolve([{ allTime: [], today: [] }]) }),
        };
      },
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

const A = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

/** A token minted by a *correctly configured* instance, for replay attempts. */
const FORGED = `${A}.${String(Date.now())}.Zm9yZ2VkLXNpZ25hdHVyZS1ub3QtcmVhbA`;

function client(token?: string): Record<string, string> {
  const octet = (): number => Math.floor(Math.random() * 250);
  return {
    "x-forwarded-for": `10.${String(octet())}.${String(octet())}.${String(octet())}`,
    ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * The whole app, assembled as index.ts assembles it, with the secrets this
 * case wants — set **before** the routers are imported, which is the only
 * ordering under which `identity.ts` reads them at all.
 */
async function boot(learnerSecret: string | null): Promise<Server> {
  if (learnerSecret === null) delete process.env.LEARNER_TOKEN_SECRET;
  else process.env.LEARNER_TOKEN_SECRET = learnerSecret;
  delete process.env.DIAGNOSTICS_TOKEN;
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

  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use("/api/v1", pronunciationRouter);
  app.use("/api/v1", diagnosticsRouter);
  app.use("/api/v1", learnersRouter);
  app.use("/api/v1", syncRouter);
  app.use("/api/v1", nextRouter);
  app.use("/api/v1", contentRouter);
  app.use(healthRouter);

  return new Promise<Server>((ready) => {
    const server = app.listen(0, () => ready(server));
  });
}

/* ── LEARNER_TOKEN_SECRET ───────────────────────────────────────────────── */

/**
 * Both spellings of "missing", because a `.env` line reading
 * `LEARNER_TOKEN_SECRET=` produces an empty string rather than an absent
 * variable — and an empty HMAC key is a perfectly usable one, so treating it
 * as configured would mean signing every token with a key that is public by
 * construction.
 */
describe.each([
  ["unset", null],
  ["set to an empty string", ""],
] as Array<[string, string | null]>)("with LEARNER_TOKEN_SECRET %s", (_label, secret) => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    touched = [];
    server = await boot(secret);
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    delete process.env.LEARNER_TOKEN_SECRET;
    delete process.env.MAX_DAILY_SCORING_CALLS;
  });

  it("says so on its own readiness surface, which is how this test knows it is the right instance", async () => {
    const res = await fetch(`${base}/readyz`);
    const body = (await res.json()) as { identity: boolean };

    // `identityConfigured()` from the same module graph `requireLearner` uses.
    // Every assertion below rests on this one.
    expect(body.identity).toBe(false);
  });

  it("reports the instance ready anyway, because identity is optional by design", async () => {
    // Refusing traffic over an optional feature would take the product down
    // to protect a capability nobody was promised.
    const res = await fetch(`${base}/readyz`);
    const body = (await res.json()) as { ready: boolean };

    expect(body.ready).toBe(true);
  });

  const PROTECTED: Array<[string, string]> = [
    ["GET", "/api/v1/sync"],
    ["POST", "/api/v1/sync"],
    ["POST", "/api/v1/learners/rotate"],
    ["GET", "/api/v1/learners/me/export"],
    ["DELETE", "/api/v1/learners/me"],
    ["GET", "/api/v1/next?slug=fr"],
  ];

  it.each(PROTECTED)("refuses %s %s rather than serving it unauthenticated", async (method, path) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...client() },
      ...(method === "POST" ? { body: "{}" } : {}),
    });

    // 503, not 401: there is nothing wrong with the caller, and a 401 would
    // send the client off to register — which cannot work either.
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("MISCONFIGURED");
  });

  it.each(PROTECTED)("refuses %s %s even when a token is presented", async (method, path) => {
    // Nothing to check a signature against, so a token is not evidence.
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...client(FORGED) },
      ...(method === "POST" ? { body: "{}" } : {}),
    });

    expect(res.status).toBe(503);
  });

  it("issues no token rather than signing with an empty key", async () => {
    const res = await fetch(`${base}/api/v1/learners`, {
      method: "POST",
      headers: { "content-type": "application/json", ...client() },
      body: JSON.stringify({ learnerId: A }),
    });
    const body = (await res.json()) as { token?: string; error?: { code: string } };

    expect(res.status).toBe(503);
    expect(body.token).toBeUndefined();
    expect(body.error?.code).toBe("MISCONFIGURED");
  });

  it("does not open when the variable is set after the app was built", async () => {
    /**
     * The gotcha, asserted rather than avoided. The secret is read at module
     * load, so setting it now configures nothing that is running — and the
     * safe consequence is that the door stays shut. A test that set the
     * variable here and expected a 200 would be testing its own harness.
     */
    process.env.LEARNER_TOKEN_SECRET = "set-far-too-late-to-matter";
    try {
      const res = await fetch(`${base}/api/v1/sync`, { headers: client(FORGED) });
      const ready = (await (await fetch(`${base}/readyz`)).json()) as { identity: boolean };

      expect(res.status).toBe(503);
      expect(ready.identity).toBe(false);
    } finally {
      if (secret === null) delete process.env.LEARNER_TOKEN_SECRET;
      else process.env.LEARNER_TOKEN_SECRET = secret;
    }
  });

  it("still lets an unregistered learner practise", async () => {
    /**
     * The other half of the rule. `optionalLearner` returns `next()` when
     * identity is off, so scoring stays reachable — a learner who has never
     * registered must still be able to take a turn, and "fail closed" applied
     * here would close the product rather than a feature.
     *
     * The 400 is the missing audio part, which is the route's own validation
     * doing its job: the request reached the handler.
     */
    const res = await fetch(`${base}/api/v1/pronunciation`, { method: "POST", headers: client() });
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("MISSING_AUDIO");
  });

  it("still accepts a client's error report", async () => {
    // Fire-and-forget telemetry from a browser that has no token to send, and
    // most useful precisely when identity is what is broken.
    const res = await fetch(`${base}/api/v1/diagnostics`, {
      method: "POST",
      headers: { "content-type": "application/json", ...client() },
      body: JSON.stringify({ code: "SNR_TOO_LOW" }),
    });

    expect(res.status).toBe(204);
  });

  it("still serves the content a client needs before it has an identity", async () => {
    // 404 is the documented answer for a language nobody has published — the
    // client falls back to its bundled set. What matters is that it is not a
    // 401 or a 503.
    const res = await fetch(`${base}/api/v1/content/fr`, { headers: client() });

    expect(res.status).toBe(404);
  });
});

/* ── DIAGNOSTICS_TOKEN ──────────────────────────────────────────────────── */

describe("with DIAGNOSTICS_TOKEN missing", () => {
  let server: Server;
  let base: string;

  /** Every surface the diagnostics secret stands in front of. */
  const GATED: Array<[string, string]> = [
    ["GET", "/api/v1/attempts"],
    ["GET", "/api/v1/diagnostics"],
    ["GET", "/api/v1/spend"],
    ["GET", "/metrics"],
    ["GET", "/api/v1/content/fr/versions"],
    ["GET", "/api/v1/content/fr/versions/1"],
    ["POST", "/api/v1/content/fr"],
  ];

  beforeAll(async () => {
    touched = [];
    // A configured learner secret, so nothing here can pass or fail for the
    // other secret's reasons.
    server = await boot("failclosed-suite-secret");
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    delete process.env.LEARNER_TOKEN_SECRET;
    delete process.env.DIAGNOSTICS_TOKEN;
    delete process.env.MAX_DAILY_SCORING_CALLS;
  });

  async function call(method: string, path: string, token?: string): Promise<Response> {
    return fetch(`${base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...client(),
        ...(token !== undefined ? { "x-diagnostics-token": token } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify({ baseVersion: 0, code: "fr-FR", label: "French", activities: [] }) } : {}),
    });
  }

  it.each(GATED)("refuses %s %s rather than opening it", async (method, path) => {
    touched = [];
    const res = await call(method, path);

    expect(res.status).toBe(401);
    // The gate runs before any read, so the store is never reached — only the
    // limiter's own collection is.
    expect(touched.filter((name) => name !== "ratelimits")).toEqual([]);
  });

  it.each(GATED)("says it is disabled on %s %s, not that the token was wrong", async (method, path) => {
    const res = await call(method, path);
    const body = (await res.json()) as { error: string };

    // A responder told "invalid token" goes looking for the right one. Told
    // "disabled", they go and set the variable, which is the actual remedy.
    expect(body.error).toMatch(/disabled/i);
    expect(body.error).not.toMatch(/invalid/i);
  });

  it.each(GATED)("refuses %s %s even when a token is sent, since there is nothing to check it against", async (method, path) => {
    expect((await call(method, path, "any-token-at-all")).status).toBe(401);
    expect((await call(method, path, "")).status).toBe(401);
  });

  it("treats an empty variable as unset rather than as a token to match", async () => {
    /**
     * `DIAGNOSTICS_TOKEN=` in a `.env` file is an empty string, and an empty
     * required token matched against an empty provided one would open every
     * read to a caller who sends the header with no value.
     */
    process.env.DIAGNOSTICS_TOKEN = "";
    try {
      expect((await call("GET", "/api/v1/attempts")).status).toBe(401);
      expect((await call("GET", "/api/v1/attempts", "")).status).toBe(401);
    } finally {
      delete process.env.DIAGNOSTICS_TOKEN;
    }
  });

  it("reads the variable per request, which is how this test knows it is the right instance", async () => {
    /**
     * Unlike the learner secret, this one is read on every request — so the
     * same running app can be walked from closed to open and back. Nothing but
     * the app reading the environment this test is editing could produce this
     * sequence, which is the same-instance proof for this secret.
     */
    expect((await call("GET", "/api/v1/attempts", "the-real-one")).status).toBe(401);

    process.env.DIAGNOSTICS_TOKEN = "the-real-one";
    try {
      expect((await call("GET", "/api/v1/attempts", "the-real-one")).status).toBe(200);
      expect((await call("GET", "/api/v1/attempts", "the-wrong-one")).status).toBe(401);
    } finally {
      delete process.env.DIAGNOSTICS_TOKEN;
    }

    expect((await call("GET", "/api/v1/attempts", "the-real-one")).status).toBe(401);
  });

  it("leaves the learner's own routes alone, because they are gated by the other secret", async () => {
    // The two secrets are independent. A missing diagnostics token must not
    // take sync down, and this is what would catch the two being conflated.
    const { issueToken } = await import("../identity.js");
    const res = await fetch(`${base}/api/v1/sync`, { headers: client(issueToken(A)) });

    expect(res.status).toBe(200);
  });
});
