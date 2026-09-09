/**
 * One learner's whole journey, over real HTTP, through the real app.
 *
 * Every other server test isolates a module. This one boots the application
 * the way `index.ts` does — every router, every middleware, the real limiters,
 * the real merge logic — and walks a learner from a first visit to a synced
 * second device. It exists to catch the failures that only appear between
 * units: a router mounted at the wrong path, a middleware not applied, a token
 * that verifies in isolation and is dropped in the chain, a merge that works
 * on a function call and not on a JSON round trip.
 *
 * Two things are substituted, and only two. The scoring provider, because
 * calling Azure from a test costs money and would make the suite depend on a
 * network and a key. And `getDb`, replaced by an in-memory store — a live
 * mongod would make this suite non-idempotent, which is a lesson this project
 * has already learned the expensive way: a Mongo-backed rate limiter once made
 * a behavioural suite pass on an empty collection and fail from then on.
 *
 * Everything else is the real thing, including the honesty rules. There are
 * assertions here that an indeterminate take returns no number and that
 * scoring works with no identity at all, because those are properties of the
 * whole path rather than of any one module.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Express } from "express";

/* ── the two substitutions ──────────────────────────────────────────────── */

interface Doc {
  _id: string;
  learnerId?: string;
  version?: number;
  [key: string]: unknown;
}

let store: Map<string, Doc>;

vi.mock("./db.js", () => ({
  getDb: () =>
    Promise.resolve({
      collection: (name: string) => ({
        findOne: (f: { _id: string }) => Promise.resolve(structuredClone(store.get(`${name}/${f._id}`) ?? null)),
        find: (f: Filter) => ({
          sort: () => ({ limit: () => ({ toArray: () => Promise.resolve(collect(name, f)) }) }),
          toArray: () => Promise.resolve(collect(name, f)),
        }),
        insertOne: (doc: Doc) => {
          const key = `${name}/${doc._id ?? cryptoId()}`;
          if (doc._id !== undefined && store.has(key)) {
            const err = new Error("dup") as Error & { code: number };
            err.code = 11000;
            return Promise.reject(err);
          }
          store.set(key, structuredClone({ ...doc, _id: doc._id ?? key }));
          return Promise.resolve({ acknowledged: true });
        },
        updateOne: (
          f: Filter & { _id: string },
          u: Record<string, Record<string, unknown>>,
          o?: { upsert?: boolean },
        ) => {
          const key = `${name}/${f._id}`;
          const existing = store.get(key);
          if (existing === undefined && o?.upsert !== true) {
            return Promise.resolve({ matchedCount: 0, acknowledged: true });
          }
          // Every other condition on the filter — the version guard, and the
          // limiter's `hits: { $gt: 0 }` — has to hold too, or a conditional
          // update becomes an unconditional one.
          if (existing !== undefined && !matches(existing, f)) {
            return Promise.resolve({ matchedCount: 0, acknowledged: true });
          }
          store.set(key, applyUpdate(existing, f._id, u));
          return Promise.resolve({ matchedCount: 1, acknowledged: true });
        },
        findOneAndUpdate: (f: Filter & { _id: string }, u: Record<string, Record<string, unknown>>) => {
          const key = `${name}/${f._id}`;
          const existing = store.get(key);
          /**
           * Mongo's own behaviour for a conditional upsert, which is what the
           * spend ceiling relies on: when the filter does not match the
           * document that is there, the upsert falls through to an insert and
           * collides on `_id`. Expressed through the shared matcher rather
           * than as a special case for one field name, so the ceiling's guard
           * is honoured whatever it comes to be phrased as.
           */
          if (existing !== undefined && !matches(existing, f)) {
            const err = new Error("E11000 duplicate key") as Error & { code: number };
            err.code = 11000;
            return Promise.reject(err);
          }
          const next = applyUpdate(existing, f._id, u);
          store.set(key, next);
          return Promise.resolve(next);
        },
        deleteMany: (f: Filter) => {
          // Returns deletedCount, as the driver does. Without it the route's
          // reported counts are undefined and vanish from the JSON — which is
          // exactly how the assertion below caught this mock being wrong.
          let deletedCount = 0;
          for (const [k, v] of store) {
            if (k.startsWith(`${name}/`) && matches(v, f)) {
              store.delete(k);
              deletedCount += 1;
            }
          }
          return Promise.resolve({ acknowledged: true, deletedCount });
        },
        deleteOne: (f: { _id: string }) => {
          store.delete(`${name}/${f._id}`);
          return Promise.resolve({ acknowledged: true });
        },
        createIndex: () => Promise.resolve("ok"),
        aggregate: () => ({ toArray: () => Promise.resolve([{ allTime: [], today: [] }]) }),
      }),
    }),
}));

function cryptoId(): string {
  return Math.random().toString(36).slice(2);
}

/** What the app actually passes as a query. Nothing else is accepted. */
type Filter = Record<string, unknown>;

/**
 * Whether one stored document satisfies a filter.
 *
 * Strict on purpose, in both directions: every condition in the filter must
 * hold, and a condition this does not understand throws instead of being
 * ignored.
 *
 * It used to compare `doc.learnerId` to `filter.learnerId` and consider
 * nothing else, which made the mock permissive in the one place that matters.
 * `deleteRateLimitsFor` filters on an anchored `_id` regex, and rate-limit
 * documents carry no `learnerId` at all, so the comparison was `undefined ===
 * undefined` — true for every document in the collection. The deletion
 * therefore appeared to work no matter what: with the regex broken, with the
 * anchoring dropped, with the whole call removed. It also swept away other
 * learners' windows, and nothing noticed, because the only assertion about
 * them was that some other collections still had rows.
 *
 * Throwing on an unrecognised condition is the other half. A filter shape
 * added later — a date range, an `$in` — would otherwise be silently ignored,
 * and a query meant to select a few documents would match all of them.
 */
function matches(doc: Doc, filter: Filter): boolean {
  for (const [field, condition] of Object.entries(filter)) {
    const value = doc[field];

    if (typeof condition === "object" && condition !== null) {
      const ops = condition as { $regex?: unknown; $gt?: unknown; $lt?: unknown };

      if (typeof ops.$regex === "string") {
        if (typeof value !== "string" || !new RegExp(ops.$regex).test(value)) return false;
        continue;
      }
      if (typeof ops.$gt === "number") {
        if (typeof value !== "number" || value <= ops.$gt) return false;
        continue;
      }
      if (typeof ops.$lt === "number") {
        if (typeof value !== "number" || value >= ops.$lt) return false;
        continue;
      }
      throw new Error(`e2e mock: filter on ${field} uses an operator it does not implement`);
    }

    if (value !== condition) return false;
  }
  return true;
}

function collect(name: string, f: Filter): Doc[] {
  return [...store.entries()]
    .filter(([k, v]) => k.startsWith(`${name}/`) && matches(v, f))
    .map(([, v]) => structuredClone(v));
}

function applyUpdate(existing: Doc | undefined, id: string, u: Record<string, Record<string, unknown>>): Doc {
  const inc = u["$inc"] ?? {};
  const set = u["$set"] ?? {};
  const onInsert = existing === undefined ? (u["$setOnInsert"] ?? {}) : {};
  const base: Record<string, unknown> = existing ? { ...existing } : { _id: id, ...onInsert };
  for (const [k, v] of Object.entries(inc)) base[k] = ((base[k] as number) ?? 0) + (v as number);
  return { ...base, ...set } as Doc;
}

let providerBehaviour: () => Promise<unknown>;

const SCORED = {
  indeterminate: false,
  provider: "azure",
  recognized: "Bonjour, comment allez-vous",
  overall: 92,
  accuracy: 95,
  fluency: 90,
  completeness: 100,
  words: [
    {
      word: "Bonjour",
      accuracy: 94,
      errorType: "None",
      phonemes: [],
      syllables: [{ grapheme: "bon", accuracy: 88, offsetTicks: 400000, durationTicks: 2500000 }],
    },
  ],
};

/**
 * The vendor class is replaced, not `getScoringProvider`.
 *
 * Mocking the module would remove `withDailyCap` from the chain along with
 * the vendor — and then the spend ceiling, which is the guard this whole
 * journey is supposed to exercise, would not be in the path at all. Caught by
 * the counter assertion below reading zero: the reservation had never run.
 */
vi.mock("./services/azureSpeech.js", () => ({
  AzureSpeechProvider: class {
    name = "azure";
    score() {
      return providerBehaviour();
    }
  },
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/* ── a real WAV, since the route decodes the header (FR-19) ─────────────── */

function wav(seconds = 2): Buffer {
  const sampleRate = 16000;
  const bytesPerFrame = 2;
  const dataBytes = Math.round(seconds * sampleRate) * bytesPerFrame;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * bytesPerFrame, 28);
  buf.writeUInt16LE(bytesPerFrame, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

/* ── the app, assembled as index.ts assembles it ────────────────────────── */

const SECRET = "e2e-secret-not-a-real-one";
const LEARNER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SECOND_LEARNER = "11111111-2222-4333-8444-555555555555";

let server: Server;
let base: string;

/**
 * The deletion/export contract, taken from the module instance the running app
 * uses — not from a top-level import.
 *
 * `boot()` calls `vi.resetModules()`, so a static import of the same file at
 * the top of this test would give a *second* instance of it: a different
 * limiter, a different token layer, and a list that no longer has to be the
 * one the server is answering from. This project has already had four
 * assertions pass against the wrong instance that way. Reading it out of
 * `boot()`'s own import is what makes "the export and the deletion agree" a
 * claim about the app rather than about a copy of its source.
 */
let learnerCollections: readonly string[];

interface Snapshot {
  progress: Array<{ slug: string; entries: Array<{ activityId: number; passed: boolean; bestAccuracy: number | null; attemptsUsed: number }> }>;
  skills: Array<{ slug: string; skills: Array<{ grapheme: string; samples: Array<{ at: string; accuracy: number }> }> }>;
  streak: { days: string[]; longest: number };
}

async function boot(): Promise<Express> {
  process.env.LEARNER_TOKEN_SECRET = SECRET;
  process.env.MAX_DAILY_SCORING_CALLS = "500";
  vi.resetModules();

  const express = (await import("express")).default;
  const { pronunciationRouter } = await import("./routes/pronunciation.js");
  const { diagnosticsRouter } = await import("./routes/diagnostics.js");
  const learners = await import("./routes/learners.js");
  const { learnersRouter } = learners;
  learnerCollections = learners.LEARNER_COLLECTIONS;
  const { syncRouter } = await import("./routes/sync.js");
  const { nextRouter } = await import("./routes/next.js");
  const { contentRouter } = await import("./routes/content.js");

  const app = express();
  // Exactly as index.ts sets it (NFR-04).
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use("/api/v1", pronunciationRouter);
  app.use("/api/v1", diagnosticsRouter);
  app.use("/api/v1", learnersRouter);
  app.use("/api/v1", syncRouter);
  app.use("/api/v1", nextRouter);
  app.use("/api/v1", contentRouter);
  return app;
}

/** A distinct address per call, so the shared limiter is never what fails. */
function client(token?: string): Record<string, string> {
  return {
    "x-forwarded-for": `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
    ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function register(learnerId: string, displayName?: string): Promise<string> {
  const res = await fetch(`${base}/api/v1/learners`, {
    method: "POST",
    headers: { "content-type": "application/json", ...client() },
    body: JSON.stringify({ learnerId, displayName, locale: "fr-FR" }),
  });
  if (res.status !== 200) throw new Error(`register failed: ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

async function score(token?: string): Promise<Response> {
  const form = new FormData();
  form.append("audio", new Blob([new Uint8Array(wav())], { type: "audio/wav" }), "capture.wav");
  form.append("referenceText", "Bonjour, comment allez-vous");
  form.append("language", "fr-FR");
  return fetch(`${base}/api/v1/pronunciation`, { method: "POST", headers: client(token), body: form });
}

async function pushSync(body: unknown, token: string): Promise<Snapshot> {
  const res = await fetch(`${base}/api/v1/sync`, {
    method: "POST",
    headers: { "content-type": "application/json", ...client(token) },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) throw new Error(`sync push failed: ${res.status}`);
  return (await res.json()) as Snapshot;
}

async function pullSync(token: string): Promise<Snapshot> {
  const res = await fetch(`${base}/api/v1/sync`, { headers: client(token) });
  if (res.status !== 200) throw new Error(`sync pull failed: ${res.status}`);
  return (await res.json()) as Snapshot;
}

beforeAll(async () => {
  const app = await boot();
  await new Promise<void>((ready) => {
    server = app.listen(0, () => ready());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  delete process.env.LEARNER_TOKEN_SECRET;
  delete process.env.MAX_DAILY_SCORING_CALLS;
});

beforeEach(() => {
  store = new Map();
  providerBehaviour = () => Promise.resolve(SCORED);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("a learner's first session, end to end", () => {
  it("registers, scores a take, and finds the attempt attributed to them", async () => {
    const token = await register(LEARNER, "Marie");

    const res = await score(token);
    const body = (await res.json()) as { overall: number; indeterminate: boolean };

    expect(res.status).toBe(200);
    expect(body.overall).toBe(92);

    const attempts = collect("attempts", {});
    expect(attempts).toHaveLength(1);
    // The whole point of the identity work: an attempt that can be attributed.
    expect(attempts[0]?.["learnerId"]).toBe(LEARNER);
  });

  it("records the learner with the name they typed", async () => {
    await register(LEARNER, "Marie");
    await new Promise((r) => setTimeout(r, 20));

    expect(store.get(`learners/${LEARNER}`)).toMatchObject({ displayName: "Marie", locale: "fr-FR" });
  });

  it("keeps the syllables past the attempt's own expiry", async () => {
    /**
     * Retention split by purpose, over the whole path. The attempt carries a
     * 90-day TTL because it holds the spoken phrase and the device context;
     * the syllable accuracies inside it are the learner's own record, so they
     * are rolled into `skills`, which has none. We stop keeping the take, the
     * learner keeps the history.
     */
    const token = await register(LEARNER);

    await score(token);
    await new Promise((r) => setTimeout(r, 20));

    const skills = store.get(`skills/${LEARNER}:fr`);
    expect(skills?.["skills"]).toEqual([
      { grapheme: "bon", samples: [{ at: expect.any(String), accuracy: 88 }] },
    ]);
  });

  it("rolls up nothing for an anonymous take", async () => {
    // There is nowhere to put it. The learner is still scored and still gets
    // a report; only the cross-session history needs someone to belong to.
    await score();
    await new Promise((r) => setTimeout(r, 20));

    expect([...store.keys()].filter((k) => k.startsWith("skills/"))).toEqual([]);
  });

  it("rolls up nothing from an indeterminate take", async () => {
    // R8 again: no measurement may be invented for audio the system declined
    // to judge, and an invented one here would be averaged into what the
    // learner is later told about their own pronunciation.
    providerBehaviour = () =>
      Promise.resolve({ indeterminate: true, provider: "azure", reason: "NO_SPEECH_DETECTED", words: [] });
    const token = await register(LEARNER);

    await score(token);
    await new Promise((r) => setTimeout(r, 20));

    expect([...store.keys()].filter((k) => k.startsWith("skills/"))).toEqual([]);
  });

  it("counts the call against the shared spend ceiling", async () => {
    // The ceiling is only real if it is reached through the actual route.
    const token = await register(LEARNER);

    await score(token);

    const counter = [...store.entries()].find(([k]) => k.startsWith("counters/spend:"));
    expect(counter?.[1]["calls"]).toBe(1);
  });
});

describe("scoring does not depend on having an identity", () => {
  it("scores an anonymous take", async () => {
    /**
     * A learner who has never registered must still be able to practise.
     * Identity is attribution, never a precondition — asserted here rather
     * than only at the middleware, because it is the whole chain that has to
     * hold it.
     */
    const res = await score();

    expect(res.status).toBe(200);
    expect(collect("attempts", {})[0]?.["learnerId"]).toBeUndefined();
  });

  it("scores a take carrying a forged token, unattributed", async () => {
    const res = await score(`${LEARNER}.1.not-a-signature`);

    expect(res.status).toBe(200);
    expect(collect("attempts", {})[0]?.["learnerId"]).toBeUndefined();
  });
});

describe("R8 survives the whole path", () => {
  it("returns no number for an indeterminate take", async () => {
    /**
     * The honesty rule that matters most, checked end to end rather than at
     * the provider boundary: unusable audio must produce no score anywhere in
     * the response, however many layers it passed through.
     */
    providerBehaviour = () =>
      Promise.resolve({ indeterminate: true, provider: "azure", reason: "NO_SPEECH_DETECTED", words: [] });
    const token = await register(LEARNER);

    const res = await score(token);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body["indeterminate"]).toBe(true);
    expect(body["overall"]).toBeUndefined();
    expect(body["accuracy"]).toBeUndefined();
    // And nothing numeric smuggled in under another name.
    const numbers = Object.entries(body).filter(([, v]) => typeof v === "number");
    expect(numbers).toEqual([]);
  });

  it("still bills an indeterminate take, because the provider charged for it", async () => {
    providerBehaviour = () =>
      Promise.resolve({ indeterminate: true, provider: "azure", reason: "NO_SPEECH_DETECTED", words: [] });
    const token = await register(LEARNER);

    await score(token);

    const counter = [...store.entries()].find(([k]) => k.startsWith("counters/spend:"));
    expect(counter?.[1]["indeterminateCalls"]).toBe(1);
  });
});

describe("a second device", () => {
  it("picks up everything the first device did", async () => {
    /**
     * The journey the product exists to support, and the thing that was
     * impossible before any of this work: practise on one device, open
     * another, and find your own record.
     */
    const first = await register(LEARNER);

    await pushSync(
      {
        progress: [
          {
            slug: "fr",
            entries: [
              { activityId: 1, passed: true, bestAccuracy: 88, attemptsUsed: 2, skipped: false, at: "2026-09-06T10:00:00.000Z" },
            ],
          },
        ],
        skills: [{ slug: "fr", skills: [{ grapheme: "bon", samples: [{ at: "2026-09-06T10:00:00.000Z", accuracy: 88 }] }] }],
        streak: { days: ["2026-09-06"], longest: 1 },
      },
      first,
    );

    // The same learner on another device: same id, its own token.
    const second = await register(LEARNER);
    const pulled = await pullSync(second);

    expect(pulled.progress[0]?.entries[0]).toMatchObject({ passed: true, bestAccuracy: 88 });
    expect(pulled.skills[0]?.skills[0]?.grapheme).toBe("bon");
    expect(pulled.streak.days).toEqual(["2026-09-06"]);
  });

  it("does not lose either device's practice day", async () => {
    // The streak union, over real HTTP. Last-write-wins here would silently
    // delete a day the learner actually practised.
    const token = await register(LEARNER);
    await pushSync({ streak: { days: ["2026-09-06"], longest: 1 } }, token);

    const merged = await pushSync({ streak: { days: ["2026-09-07"], longest: 1 } }, token);

    expect(merged.streak.days).toEqual(["2026-09-06", "2026-09-07"]);
  });

  it("never un-passes an activity a stale device disagrees about", async () => {
    const token = await register(LEARNER);
    await pushSync(
      { progress: [{ slug: "fr", entries: [{ activityId: 1, passed: true, bestAccuracy: 88, attemptsUsed: 2, skipped: false, at: "2026-09-07T10:00:00.000Z" }] }] },
      token,
    );

    const merged = await pushSync(
      { progress: [{ slug: "fr", entries: [{ activityId: 1, passed: false, bestAccuracy: 20, attemptsUsed: 1, skipped: false, at: "2026-09-01T10:00:00.000Z" }] }] },
      token,
    );

    expect(merged.progress[0]?.entries[0]).toMatchObject({ passed: true, bestAccuracy: 88, attemptsUsed: 2 });
  });

  it("keeps one learner's record out of another's", async () => {
    const mine = await register(LEARNER);
    const theirs = await register(SECOND_LEARNER);
    await pushSync({ streak: { days: ["2026-09-07"], longest: 1 } }, mine);

    expect((await pullSync(theirs)).streak.days).toEqual([]);
  });
});

describe("what to practise next, from what was scored", () => {
  it("schedules the sound a take just measured", async () => {
    /**
     * The loop the product runs on, end to end: a take is scored, its
     * syllables become history, and the history decides what comes next. None
     * of the three steps is visible from the others in a unit test.
     */
    const token = await register(LEARNER);
    // One take, deliberately. Two would make this assertion depend on whether
    // both landed in the same millisecond — a sample's identity is its
    // timestamp, so same-millisecond takes collapse into one. It is harmless
    // in reality (a take needs a recording and a round trip) and it made this
    // test flake between one sample and two.
    await score(token);
    await new Promise((r) => setTimeout(r, 30));

    const res = await fetch(`${base}/api/v1/next?slug=fr`, { headers: client(token) });
    const body = (await res.json()) as {
      slug: string;
      due: Array<{ grapheme: string; strength: number }>;
      all: Array<{ grapheme: string; step: number; samples: number }>;
      activitySelected: boolean;
    };

    expect(res.status).toBe(200);
    expect(body.slug).toBe("fr");
    expect(body.all.map((s) => s.grapheme)).toEqual(["bon"]);
    expect(body.all[0]?.samples).toBe(1);
    // 88 is strong, so one take climbs one rung and the sound is not due
    // again for three days.
    expect(body.all[0]?.step).toBe(1);
    expect(body.due).toEqual([]);
    // Named rather than omitted, so a client can tell "not implemented" from
    // "nothing to recommend".
    expect(body.activitySelected).toBe(false);
  });

  it("returns an empty schedule for a learner with no history", async () => {
    // Not an error: a first visit has nothing due, and the client has its own
    // ordering to start with.
    const token = await register(LEARNER);

    const res = await fetch(`${base}/api/v1/next?slug=fr`, { headers: client(token) });

    expect(res.status).toBe(200);
    expect((await res.json()) as { due: unknown[]; all: unknown[] }).toMatchObject({ due: [], all: [] });
  });

  it("refuses without a token, and without a language", async () => {
    const token = await register(LEARNER);

    expect((await fetch(`${base}/api/v1/next?slug=fr`, { headers: client() })).status).toBe(401);
    expect((await fetch(`${base}/api/v1/next`, { headers: client(token) })).status).toBe(400);
    expect((await fetch(`${base}/api/v1/next?slug=../etc`, { headers: client(token) })).status).toBe(400);
  });
});

describe("serving content", () => {
  it("tells the client to use its bundled set when nothing is published", async () => {
    /**
     * A 404 is the normal answer, not an error. The client falls back to the
     * activities it shipped with, which is what keeps the app working with no
     * network at all — content that only exists in a database is content a
     * learner on a train cannot practise.
     */
    const res = await fetch(`${base}/api/v1/content/fr`, { headers: client() });
    const body = (await res.json()) as { error: { userMessage: string } };

    expect(res.status).toBe(404);
    expect(body.error.userMessage).toMatch(/built into the app/i);
  });

  it("serves a published set without needing a learner token", async () => {
    /**
     * Content is not personal, and the client needs the words before a
     * learner has registered. Requiring identity here would make the
     * offline-first story worse for nothing.
     */
    store.set("content/fr:1", {
      _id: "fr:1",
      slug: "fr",
      code: "fr-FR",
      label: "French",
      version: 1,
      activities: [
        {
          id: 1,
          title: "Greeting",
          kind: "repeat",
          prompt: "Say hello",
          gloss: "hello",
          target: "Bonjour",
          focus: "the French r",
        },
      ],
      publishedAt: new Date(),
    } as never);

    const res = await fetch(`${base}/api/v1/content/fr`, { headers: client() });
    const body = (await res.json()) as { version: number; activities: Array<{ target: string }> };

    expect(res.status).toBe(200);
    expect(body.version).toBe(1);
    expect(body.activities[0]?.target).toBe("Bonjour");
  });

  it("refuses a slug that is not a slug", async () => {
    const res = await fetch(`${base}/api/v1/content/..%2Fetc`, { headers: client() });

    expect(res.status).toBe(400);
  });
});

describe("erasing everything, on request", () => {
  /**
   * Drives every write path that can attribute something to this learner.
   *
   * Through the real endpoints rather than by seeding the store, which is the
   * whole point: a collection a *route* starts writing gets swept into the
   * assertions below without anyone remembering to add it here, whereas a
   * hand-seeded fixture only ever contains what somebody thought of.
   *
   * Deliberately more than one of everything, and more than one language. A
   * deletion filtered by `_id` rather than by learner, or one that stops after
   * the first document, passes against a single row per collection.
   */
  async function fillEverything(token: string): Promise<string> {
    // Two takes: two attempts, two spend counter increments, and — the part
    // that matters here — a rate-limit window keyed on the learner rather
    // than on the address.
    await score(token);
    await score(token);

    for (const code of ["MIC_BLOCKED", "NO_SPEECH_DETECTED"]) {
      await fetch(`${base}/api/v1/diagnostics`, {
        method: "POST",
        headers: { "content-type": "application/json", ...client(token) },
        body: JSON.stringify({ code, domain: "client", message: "no permission" }),
      });
    }

    // Two languages, so `progress` and `skills` hold two documents each and a
    // deletion cannot pass by removing one of them.
    for (const slug of ["fr", "hi"]) {
      await pushSync(
        {
          progress: [{ slug, entries: [{ activityId: 1, passed: true, bestAccuracy: 88, attemptsUsed: 2, skipped: false, at: "2026-09-07T10:00:00.000Z" }] }],
          skills: [{ slug, skills: [{ grapheme: "ment", samples: [{ at: "2026-09-07T10:00:00.000Z", accuracy: 61 }] }] }],
          streak: { days: ["2026-09-07"], longest: 1 },
        },
        token,
      );
    }

    // A read as well as writes: `requireLearner` refreshes `lastSeenAt` on
    // every authenticated request, which is itself a write to `learners`.
    await fetch(`${base}/api/v1/next?slug=fr`, { headers: client(token) });

    // And a rotated token, since a learner who rotates mid-journey must not
    // end up with a record the deletion cannot reach.
    const res = await fetch(`${base}/api/v1/learners/rotate`, {
      method: "POST",
      headers: { "content-type": "application/json", ...client(token) },
      body: "{}",
    });
    const rotated = ((await res.json()) as { token: string }).token;

    // The scoring, diagnostics and lastSeenAt writes are fire-and-forget.
    await new Promise((r) => setTimeout(r, 40));
    return rotated;
  }

  /** Every stored document mentioning this learner, by collection. */
  function traceOf(learnerId: string): string[] {
    return [...store.entries()]
      .filter(([k, v]) => JSON.stringify(v).includes(learnerId) || k.includes(learnerId))
      .map(([k]) => k.split("/")[0] ?? k)
      .filter((c, i, all) => all.indexOf(c) === i)
      .sort();
  }

  /** Every stored key mentioning this learner, for naming what survived. */
  function keysMentioning(learnerId: string): string[] {
    return [...store.entries()]
      .filter(([k, v]) => JSON.stringify(v).includes(learnerId) || k.includes(learnerId))
      .map(([k]) => k)
      .sort();
  }

  async function exportOf(token: string): Promise<{
    collections: Record<string, unknown>;
    truncated: Record<string, boolean>;
  }> {
    const res = await fetch(`${base}/api/v1/learners/me/export`, { headers: client(token) });
    if (res.status !== 200) throw new Error(`export failed: ${res.status}`);
    return (await res.json()) as { collections: Record<string, unknown>; truncated: Record<string, boolean> };
  }

  /** How much a collection holds — a list's length, or 1 for a lone document. */
  function weight(value: unknown): number {
    if (value === null || value === undefined) return 0;
    return Array.isArray(value) ? value.length : 1;
  }

  it("leaves nothing behind in any collection", async () => {
    /**
     * The test the privacy posture rests on. It seeds every collection through
     * the real endpoints — so a collection added later gets swept up by this
     * assertion rather than being quietly missed — and then requires that no
     * stored document mentions the learner at all.
     */
    const token = await register(LEARNER, "Marie");
    await fillEverything(token);

    // Guard against the test passing because nothing was ever written.
    expect(traceOf(LEARNER)).toEqual(
      expect.arrayContaining(["attempts", "diagnostics", "learners", "progress", "skills", "streaks"]),
    );

    const res = await fetch(`${base}/api/v1/learners/me`, { method: "DELETE", headers: client(token) });

    expect(res.status).toBe(200);
    expect(traceOf(LEARNER)).toEqual([]);
  });

  it("reports what it removed, so the deletion can be checked", async () => {
    // A silent 204 is indistinguishable from a deletion that missed a
    // collection somebody added later.
    const token = await register(LEARNER);
    await fillEverything(token);

    const res = await fetch(`${base}/api/v1/learners/me`, { method: "DELETE", headers: client(token) });

    // Two of each, because `fillEverything` writes two of each: a count that
    // is really a boolean cannot show that a deletion reached past the first
    // document it found.
    expect((await res.json()) as { deleted: boolean; attempts: number; diagnostics: number }).toEqual({
      deleted: true,
      attempts: 2,
      diagnostics: 2,
    });
  });

  it("erases nobody else", async () => {
    const mine = await register(LEARNER);
    const theirs = await register(SECOND_LEARNER);
    await fillEverything(mine);
    await fillEverything(theirs);

    await fetch(`${base}/api/v1/learners/me`, { method: "DELETE", headers: client(mine) });

    expect(traceOf(LEARNER)).toEqual([]);
    expect(traceOf(SECOND_LEARNER)).toEqual(
      expect.arrayContaining(["attempts", "learners", "progress", "skills", "streaks"]),
    );
  });

  it("refuses to erase without a valid token", async () => {
    // Otherwise anyone could erase anyone by sending their id.
    const token = await register(LEARNER);
    await fillEverything(token);

    const bare = await fetch(`${base}/api/v1/learners/me`, { method: "DELETE", headers: client(LEARNER) });
    const none = await fetch(`${base}/api/v1/learners/me`, { method: "DELETE", headers: client() });

    expect(bare.status).toBe(401);
    expect(none.status).toBe(401);
    expect(traceOf(LEARNER).length).toBeGreaterThan(0);
  });

  it("is safe to repeat", async () => {
    // Deletion is idempotent, which is what makes retrying a part-way failure
    // the right response rather than a risk.
    const token = await register(LEARNER);
    await fillEverything(token);

    await fetch(`${base}/api/v1/learners/me`, { method: "DELETE", headers: client(token) });
    const second = await fetch(`${base}/api/v1/learners/me`, { method: "DELETE", headers: client(token) });

    expect(second.status).toBe(200);
    expect(traceOf(LEARNER)).toEqual([]);
  });

  it("holds nothing about a learner outside the collections it declares", async () => {
    /**
     * The sweep, in the direction nobody thinks to check.
     *
     * `LEARNER_COLLECTIONS` is the contract between the export and the
     * deletion. It is only worth anything if it is *complete* — a route that
     * starts attributing data to a learner in a collection nobody added to
     * that list is invisible to both halves of a data request, and the
     * rate-limiter shipped exactly that.
     *
     * So this compares the declared list against what the app actually wrote,
     * both ways, with neither side hard-coded here:
     *
     *   declared ⊇ observed — a new collection holding learner data fails
     *     this until it is declared, which is the automatic part.
     *   declared ⊆ observed — a declared collection that no endpoint fills
     *     fails this, so the deletion assertions below can never be vacuous
     *     for a collection that was empty all along.
     */
    const token = await register(LEARNER, "Marie");
    await fillEverything(token);

    expect(traceOf(LEARNER)).toEqual([...learnerCollections].sort());
  });

  it("exports every collection it will delete, and with something in it", async () => {
    /**
     * The other half of the same contract. The route types the export as a
     * record over `LEARNER_COLLECTIONS`, so a missing key is a compile error
     * — but a key present and permanently empty is not, and an export that
     * returns `[]` for a collection full of the learner's records is the more
     * likely failure. Checked over the real HTTP response, collection for
     * collection, against the same list the deletion uses.
     */
    const token = await register(LEARNER, "Marie");
    await fillEverything(token);

    const exported = await exportOf(token);

    expect(Object.keys(exported.collections).sort()).toEqual([...learnerCollections].sort());
    for (const collection of learnerCollections) {
      expect(weight(exported.collections[collection])).toBeGreaterThan(0);
    }
    // And it says whether the two unbounded trails were cut, rather than
    // handing back a partial copy that looks whole.
    expect(Object.keys(exported.truncated).sort()).toEqual(["attempts", "diagnostics"]);
  });

  it("leaves the export empty, collection for collection, once it has deleted", async () => {
    /**
     * Absence checked through the learner's own eyes rather than only through
     * the store. The token survives a deletion by design, so the export is
     * still reachable — and it must now answer "nothing" for every collection
     * it was answering for a moment ago.
     */
    const token = await register(LEARNER, "Marie");
    await fillEverything(token);
    const before = await exportOf(token);

    await fetch(`${base}/api/v1/learners/me`, { method: "DELETE", headers: client(token) });
    const after = await exportOf(token);

    for (const collection of learnerCollections) {
      expect(weight(before.collections[collection])).toBeGreaterThan(0);
      expect(weight(after.collections[collection])).toBe(0);
    }
    // And nothing is left in the store under a key that names them either —
    // the rate-limit leak was a document whose *id* held the learner id and
    // whose fields did not, so an assertion on fields alone would miss it.
    expect(keysMentioning(LEARNER)).toEqual([]);
  });

  it("removes the learner's rate-limit windows and nobody else's", async () => {
    /**
     * The named case. `perLearnerScoringLimiter` keys on the learner, so a
     * window's `_id` is `scoring-learner:{learnerId}:{window}` and the
     * document has no `learnerId` field at all — which is why the deletion
     * matches on an anchored `_id` pattern instead.
     *
     * Anchored on the separator in both directions, so it can only ever match
     * the key segment: another learner's windows and the address-keyed
     * diagnostics windows both have to survive. A deletion that swept the
     * collection would satisfy "nothing about this learner remains" while
     * resetting everybody's abuse counters.
     */
    const mine = await register(LEARNER);
    const theirs = await register(SECOND_LEARNER);
    await fillEverything(mine);
    await fillEverything(theirs);

    const rateLimitKeys = (): string[] => [...store.keys()].filter((k) => k.startsWith("ratelimits/")).sort();
    const before = rateLimitKeys();
    expect(before.some((k) => k.includes(LEARNER))).toBe(true);
    expect(before.some((k) => k.includes(SECOND_LEARNER))).toBe(true);
    // The address-keyed windows the diagnostics limiter writes, which belong
    // to no learner and must not be collateral.
    const addressKeyed = before.filter((k) => !k.includes(LEARNER) && !k.includes(SECOND_LEARNER));
    expect(addressKeyed.length).toBeGreaterThan(0);

    await fetch(`${base}/api/v1/learners/me`, { method: "DELETE", headers: client(mine) });

    const after = rateLimitKeys();
    expect(after.filter((k) => k.includes(LEARNER))).toEqual([]);
    expect(after.filter((k) => k.includes(SECOND_LEARNER))).toEqual(
      before.filter((k) => k.includes(SECOND_LEARNER)),
    );
    // A superset, not an exact match: the DELETE request is itself rate
    // limited, so it opens an address-keyed window of its own. What matters is
    // that none of the existing ones went away.
    for (const key of addressKeyed) expect(after).toContain(key);
  });

  it("erases nobody else, document for document", async () => {
    /**
     * Stronger than "the other learner still has some collections". Every
     * single document that did not mention the deleted learner has to be
     * exactly where it was — a deletion that over-reaches is a data-loss bug
     * wearing a privacy feature's clothes, and it would pass any assertion
     * phrased as "their record still exists".
     */
    const mine = await register(LEARNER);
    const theirs = await register(SECOND_LEARNER);
    await fillEverything(mine);
    await fillEverything(theirs);

    const untouched = [...store.entries()]
      .filter(([k, v]) => !JSON.stringify(v).includes(LEARNER) && !k.includes(LEARNER))
      .map(([k, v]) => [k, JSON.stringify(v)] as const);
    expect(untouched.length).toBeGreaterThan(0);

    await fetch(`${base}/api/v1/learners/me`, { method: "DELETE", headers: client(mine) });

    // Every document that was not about the deleted learner is still there,
    // byte for byte. Stated as "nothing was removed or altered" rather than
    // "the store is unchanged", because the DELETE request is itself rate
    // limited and legitimately opens a window of its own.
    for (const [key, before] of untouched) {
      expect(JSON.stringify(store.get(key))).toBe(before);
    }
    expect(keysMentioning(LEARNER)).toEqual([]);
  });

  it("leaves an anonymous take alone, because it belongs to nobody", async () => {
    /**
     * The honest limit, asserted rather than only written down. A take made
     * without a token carries no learner id, so nobody can find it — not us
     * and not the learner asking. Those expire on the attempts TTL instead.
     *
     * Worth pinning because the tempting "fix" is to delete unattributed
     * attempts along with the learner's, which would erase other people's
     * anonymous practice on one person's request.
     */
    const token = await register(LEARNER);
    await fillEverything(token);
    await score();
    await new Promise((r) => setTimeout(r, 30));

    const anonymous = collect("attempts", {}).filter((doc) => doc["learnerId"] === undefined);
    expect(anonymous).toHaveLength(1);

    await fetch(`${base}/api/v1/learners/me`, { method: "DELETE", headers: client(token) });

    expect(collect("attempts", {})).toHaveLength(1);
    expect(collect("attempts", {})[0]?.["learnerId"]).toBeUndefined();
    // And it mentions nobody, so the sweep above stays true.
    expect(traceOf(LEARNER)).toEqual([]);
  });

  it("erases the display name, which is the only thing a person would recognise", async () => {
    // The learner id is a UUID the client minted; the display name is the one
    // field here that a human typed about themselves. An assertion that only
    // looks for the id would pass on a record that still held the name.
    const token = await register(LEARNER, "Marie-Claire");
    await fillEverything(token);
    expect(JSON.stringify([...store.values()])).toContain("Marie-Claire");

    await fetch(`${base}/api/v1/learners/me`, { method: "DELETE", headers: client(token) });

    expect(JSON.stringify([...store.values()])).not.toContain("Marie-Claire");
  });

  it("erases a learner who rotated their token mid-journey", async () => {
    // Rotation issues a new token for the same learner. A deletion driven by
    // the new token has to reach the record the old one created.
    const original = await register(LEARNER, "Marie");
    const rotated = await fillEverything(original);

    const res = await fetch(`${base}/api/v1/learners/me`, { method: "DELETE", headers: client(rotated) });

    expect(res.status).toBe(200);
    expect(traceOf(LEARNER)).toEqual([]);
  });

  it("erases a synced document attributed only by its id", async () => {
    /**
     * The rate-limit bug class, hunted in the collections that were not the
     * rate limiter.
     *
     * `progress`, `skills` and `streaks` all put the learner id in the
     * document `_id` — `{learner}:{slug}`, or the bare id for streaks — and
     * `deleteAllFor` matches on the `learnerId` *field*. So a document holding
     * the id in its key and not in a field is precisely the shape that a
     * deletion walks past, and it is the shape a build from before that field
     * existed wrote. mergeStore now rewrites `learnerId` on every update, so
     * the next sync repairs such a document; a document never synced again
     * would never be repaired, and a deletion request is exactly the moment
     * that stops being hypothetical.
     */
    const token = await register(LEARNER, "Marie");
    await fillEverything(token);
    // Written straight in, as an older build would have left it: attributable
    // from its key alone.
    store.set(`progress/${LEARNER}:de`, {
      _id: `${LEARNER}:de`,
      slug: "de",
      entries: [],
      version: 1,
      updatedAt: new Date(),
    });
    store.set(`skills/${LEARNER}:de`, {
      _id: `${LEARNER}:de`,
      slug: "de",
      skills: [],
      version: 1,
      updatedAt: new Date(),
    });

    await fetch(`${base}/api/v1/learners/me`, { method: "DELETE", headers: client(token) });

    expect(keysMentioning(LEARNER)).toEqual([]);
  });

  it("keeps a returning learner's start date, rather than making them look new", async () => {
    /**
     * `$setOnInsert` semantics, pinned end to end because they are easy to
     * get wrong in exactly one direction: applied on every write instead of
     * only on insert, `createdAt` refreshes and every learner reads as
     * new — and the mock that stands in for Mongo here has made that mistake
     * before, which would have made this whole file agree with a broken app.
     */
    await register(LEARNER, "Marie");
    await new Promise((r) => setTimeout(r, 20));
    const first = store.get(`learners/${LEARNER}`)?.["createdAt"];

    await register(LEARNER, "Marie");
    await new Promise((r) => setTimeout(r, 20));

    expect(first).toBeDefined();
    expect(store.get(`learners/${LEARNER}`)?.["createdAt"]).toEqual(first);
    // lastSeenAt is the field that is meant to move.
    expect(store.get(`learners/${LEARNER}`)?.["lastSeenAt"]).toBeDefined();
  });

  it("lets the learner start again afterwards", async () => {
    /**
     * The token is not revoked — there is no server-side token state to revoke
     * it from — so a learner who deletes and keeps the same browser simply
     * begins a new record under the same id. Stated here because it is the
     * behaviour, not an oversight.
     */
    const token = await register(LEARNER);
    await fillEverything(token);
    await fetch(`${base}/api/v1/learners/me`, { method: "DELETE", headers: client(token) });

    const after = await pullSync(token);

    expect(after).toEqual({ progress: [], skills: [], streak: { days: [], longest: 0 } });
  });
});

describe("rotating a token mid-journey", () => {
  it("keeps the learner and their record", async () => {
    const original = await register(LEARNER);
    await pushSync({ streak: { days: ["2026-09-07"], longest: 1 } }, original);

    const res = await fetch(`${base}/api/v1/learners/rotate`, {
      method: "POST",
      headers: { "content-type": "application/json", ...client(original) },
      body: "{}",
    });
    const rotated = ((await res.json()) as { token: string }).token;

    expect(res.status).toBe(200);
    expect((await pullSync(rotated)).streak.days).toEqual(["2026-09-07"]);
  });
});

describe("the routes are mounted where the client expects", () => {
  it.each([
    ["POST", "/api/v1/learners"],
    ["POST", "/api/v1/learners/rotate"],
    ["GET", "/api/v1/sync"],
    ["POST", "/api/v1/sync"],
    ["POST", "/api/v1/pronunciation"],
    ["DELETE", "/api/v1/learners/me"],
    ["GET", "/api/v1/next?slug=fr"],
  ])("answers %s %s rather than 404", async (method, path) => {
    /**
     * A router mounted at the wrong prefix is invisible to every unit test —
     * each one mounts its own app — and shows up as a client that silently
     * cannot reach the server. Any status but 404 means the route exists.
     */
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...client() },
      ...(method === "POST" ? { body: "{}" } : {}),
    });

    expect(res.status).not.toBe(404);
  });

  it("answers GET /api/v1/content/:slug, distinguished by its body", async () => {
    /**
     * The "not 404" heuristic above cannot cover this route, because 404 is a
     * *legitimate* answer here — nothing published means "use the bundled
     * set". So mounting is confirmed by shape instead: a mounted route
     * returns the typed error envelope, while an unmounted one returns
     * Express's own HTML 404 with no JSON at all.
     */
    const res = await fetch(`${base}/api/v1/content/fr`, { headers: client() });
    const body = (await res.json()) as { error?: { code?: string; userMessage?: string } };

    expect(body.error?.userMessage).toBeDefined();
  });
});
