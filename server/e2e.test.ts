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
        find: (f: { learnerId?: string }) => ({
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
          f: { _id: string; version?: number; calls?: { $lt: number } },
          u: Record<string, Record<string, unknown>>,
          o?: { upsert?: boolean },
        ) => {
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
        findOneAndUpdate: (
          f: { _id: string; calls?: { $lt: number } },
          u: Record<string, Record<string, unknown>>,
        ) => {
          const key = `${name}/${f._id}`;
          const existing = store.get(key);
          if (f.calls !== undefined && ((existing?.["calls"] as number) ?? 0) >= f.calls.$lt) {
            const err = new Error("dup") as Error & { code: number };
            err.code = 11000;
            return Promise.reject(err);
          }
          const next = applyUpdate(existing, f._id, u);
          store.set(key, next);
          return Promise.resolve(next);
        },
        deleteMany: (f: { learnerId: string }) => {
          // Returns deletedCount, as the driver does. Without it the route's
          // reported counts are undefined and vanish from the JSON — which is
          // exactly how the assertion below caught this mock being wrong.
          let deletedCount = 0;
          for (const [k, v] of store) {
            if (k.startsWith(`${name}/`) && v.learnerId === f.learnerId) {
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

function collect(name: string, f: { learnerId?: string }): Doc[] {
  return [...store.entries()]
    .filter(([k, v]) => k.startsWith(`${name}/`) && (f.learnerId === undefined || v.learnerId === f.learnerId))
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
  const { learnersRouter } = await import("./routes/learners.js");
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
  /** Fills every collection that can hold something about this learner. */
  async function fillEverything(token: string): Promise<void> {
    await score(token);
    await fetch(`${base}/api/v1/diagnostics`, {
      method: "POST",
      headers: { "content-type": "application/json", ...client(token) },
      body: JSON.stringify({ code: "MIC_BLOCKED", domain: "client", message: "no permission" }),
    });
    await pushSync(
      {
        progress: [{ slug: "fr", entries: [{ activityId: 1, passed: true, bestAccuracy: 88, attemptsUsed: 2, skipped: false, at: "2026-09-07T10:00:00.000Z" }] }],
        skills: [{ slug: "fr", skills: [{ grapheme: "ment", samples: [{ at: "2026-09-07T10:00:00.000Z", accuracy: 61 }] }] }],
        streak: { days: ["2026-09-07"], longest: 1 },
      },
      token,
    );
    // The scoring and diagnostics writes are fire-and-forget.
    await new Promise((r) => setTimeout(r, 30));
  }

  /** Every stored document mentioning this learner, by collection. */
  function traceOf(learnerId: string): string[] {
    return [...store.entries()]
      .filter(([, v]) => JSON.stringify(v).includes(learnerId))
      .map(([k]) => k.split("/")[0] ?? k)
      .filter((c, i, all) => all.indexOf(c) === i)
      .sort();
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

    expect((await res.json()) as { deleted: boolean; attempts: number; diagnostics: number }).toEqual({
      deleted: true,
      attempts: 1,
      diagnostics: 1,
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
