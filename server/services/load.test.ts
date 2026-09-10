/**
 * The claims that only sustained traffic can check.
 *
 * Every other server test asks whether one call behaves. These ask whether a
 * *stream* of calls behaves, because four things in this server are only wrong
 * under volume and look perfectly correct one request at a time:
 *
 *   1. the metrics reservoir — bounded by design, so memory must not grow with
 *      request count, and the sample must stay uniform rather than becoming
 *      "the last thousand". metrics.ts spends a paragraph on that distinction;
 *      a ring buffer would pass every other test in this suite;
 *   2. the daily spend counter — atomic by design, so N simultaneous callers
 *      against a cap of K must produce exactly K allowed and exactly K
 *      counted. A check-then-increment counters.ts passes every sequential
 *      test in the repository and hands out N. Worth knowing before reading
 *      that section: HTTP traffic alone does **not** catch it, measured
 *      rather than assumed — 200 concurrent requests stay green against the
 *      broken version, because a multipart parse and a WAV decode stagger
 *      them enough that no two overlap at the reservation. The race is
 *      pinned by driving the reservation directly;
 *   3. the circuit breaker — it exists to make an *outage* cheap, which is a
 *      claim about the second hundred requests, not the first one;
 *   4. the heap — see "what a heap number can and cannot prove" below.
 *
 * Plus one case that is not a property but a memory: an ad-hoc probe of 480
 * concurrent oversize uploads was run by hand once, and all 480 were refused.
 * That afternoon is a test now rather than a story.
 *
 * ── the two substitutions ───────────────────────────────────────────────────
 * The vendor SDK (so nothing here spends money or needs a key) and `getDb` (so
 * nothing here needs a mongod). Everything else is the real thing: the real
 * routers, the real multer ceiling, the real limiters over their real
 * Mongo-backed store, the real `withDailyCap`, and the real
 * `AzureSpeechProvider` with its real retry loop and real breaker — over real
 * HTTP on an ephemeral port.
 *
 * The SDK is replaced rather than `AzureSpeechProvider`, unlike e2e.test.ts:
 * mocking the class removes the breaker and the retry loop from the path along
 * with the vendor, and those are two of the four things under test.
 *
 * Which is also why this file lives in `server/services/` rather than in
 * `server/infra/` next to the metrics module it spends its first section on.
 * R12 — enforced by scripts/verify.mjs — says the Azure SDK may be named only
 * inside `server/services/`, so that swapping to SpeechAce stays a file change
 * rather than a refactor. Naming it here to mock it is exactly the case the
 * rule is about, so the file moved to where the vendor is allowed to be named
 * instead of the rule moving to accommodate the file.
 *
 * The database mock is strict in both directions — every condition in a filter
 * must hold, and an operator it does not implement throws rather than being
 * ignored. A permissive mock would make the spend-ceiling assertion vacuous,
 * which is a failure mode this project has already paid for once (see the note
 * on `matches` in e2e.test.ts).
 *
 * ── what a heap number can and cannot prove ─────────────────────────────────
 * `process.memoryUsage().heapUsed` is one sample of a garbage-collected heap.
 * It moves by megabytes for reasons unrelated to any leak, and without
 * `--expose-gc` nothing here can force a collection. So an absolute or tight
 * assertion on it is a coin flip dressed as a test, and a flaky test teaches
 * people to ignore the suite.
 *
 * So both heap assertions here are order-of-magnitude guards rather than
 * measurements, both force a collection first (through `node:v8` and
 * `node:vm` when `--expose-gc` is absent — see `collectedHeap`), and both have
 * the arithmetic for their threshold written out where they are. What they can
 * prove: retention that scales with request count is not happening, because
 * millions of calls would then cost tens of megabytes. What they cannot prove:
 * that nothing leaks at all, that a leak of a few bytes per *hour* is absent,
 * or anything whatsoever about native or external memory — `heapUsed` does not
 * see Buffers, sockets, or V8's own metaspace, so a leak in the upload path's
 * Buffers would be invisible to both.
 *
 * ── what runs where ────────────────────────────────────────────────────────
 * Sections 1-4 run in `npm test`. Their volumes — 200 and 480 concurrent
 * requests, a few million histogram observations — are sized to finish in
 * about seven seconds on a laptop that is also doing something else. Every
 * assertion in them is an exact count, a bound, or a state transition; there
 * is no wall-clock assertion anywhere in this file, because a load test that
 * fails when a machine is busy is a load test people learn to skip.
 *
 * Section 5 is the soak. It is `describe.skipIf(SOAK !== "1")`, so `npm test`
 * reports it as skipped rather than silently omitting it, and a human runs it
 * with `npm run soak` — 30,000 scored requests in waves, bursts 2,000 wide,
 * and the heap series printed. Its own header says what it can and cannot
 * prove, and at what widths it stops being informative.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import v8 from "node:v8";
import vm from "node:vm";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { MetricsSnapshot } from "../infra/metrics.js";
import type { Reservation } from "../counters.js";

/* ── substitution 1: the database ───────────────────────────────────────── */

interface Doc {
  _id: string;
  [key: string]: unknown;
}

let store: Map<string, Doc>;

/** What the app actually passes as a query. Nothing else is accepted. */
type Filter = Record<string, unknown>;

/**
 * Whether one stored document satisfies a filter.
 *
 * Strict in both directions on purpose: every condition must hold, and an
 * operator this does not implement throws. The spend ceiling's guard is
 * `{ calls: { $lt: cap } }` — a matcher that ignored what it did not
 * understand would make "exactly the cap gets through" pass against an
 * implementation with no guard at all.
 */
function matches(doc: Doc, filter: Filter): boolean {
  for (const [field, condition] of Object.entries(filter)) {
    const value = doc[field];

    if (typeof condition === "object" && condition !== null) {
      const ops = condition as { $lt?: unknown; $lte?: unknown; $gt?: unknown; $regex?: unknown };
      if (typeof ops.$lt === "number") {
        if (typeof value !== "number" || value >= ops.$lt) return false;
        continue;
      }
      if (typeof ops.$lte === "number") {
        if (typeof value !== "number" || value > ops.$lte) return false;
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
      throw new Error(`load-test mock: filter on ${field} uses an operator it does not implement`);
    }

    if (value !== condition) return false;
  }
  return true;
}

function applyUpdate(existing: Doc | undefined, id: string, update: Record<string, Record<string, unknown>>): Doc {
  const inc = update["$inc"] ?? {};
  const set = update["$set"] ?? {};
  const onInsert = existing === undefined ? (update["$setOnInsert"] ?? {}) : {};
  const base: Record<string, unknown> = existing ? { ...existing } : { _id: id, ...onInsert };
  for (const [k, v] of Object.entries(inc)) base[k] = ((base[k] as number) ?? 0) + (v as number);
  return { ...base, ...set } as Doc;
}

function duplicateKey(): Error & { code: number } {
  const err = new Error("E11000 duplicate key") as Error & { code: number };
  err.code = 11000;
  return err;
}

/**
 * A yield, so concurrent callers genuinely interleave.
 *
 * This is the half of the mock that makes a concurrency assertion mean
 * anything. A mock that resolved synchronously would let every caller run its
 * read and its write back to back, so a check-then-increment implementation
 * would never lose a race and the test would pass against the bug it exists
 * to catch.
 *
 * What it deliberately does *not* do is yield *inside* one operation. Mongo's
 * `findOneAndUpdate` on a single document is atomic, so each compute below is
 * one synchronous block. A mock that interleaved within an operation would be
 * modelling a database this app is not written against, and would fail correct
 * code.
 */
function interleave(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

let generatedIds = 0;

/**
 * Which store a database operation belongs to.
 *
 * This exists because of a contamination this file found in itself while its
 * own assertions were being broken on purpose, and it would have become a
 * flake otherwise.
 *
 * The route persists the attempt and the diagnostic **after** responding, and
 * does it fire-and-forget. So a case that fires two hundred requests leaves up
 * to two hundred writes in flight when its last assertion runs, and closing
 * the server does not cancel them. Clearing the map in `beforeEach` is not
 * enough: those writes land in whatever map is current when they finally
 * resolve, which is the *next* case's — and the next case then reads
 * diagnostics it never caused. That is exactly the shape of "passes on its
 * own, fails in a full run".
 *
 * So `getDb()` stamps the generation live at the moment the operation starts,
 * and an operation from an earlier generation is dropped rather than applied.
 * Deterministic, rather than draining the event loop and hoping.
 */
let storeGeneration = 0;
/** Dropped stale operations, so the mechanism is visible rather than silent. */
let staleOperations = 0;

function collection(name: string, generation: number) {
  const key = (id: string): string => `${name}/${id}`;
  const stale = (): boolean => {
    if (generation === storeGeneration) return false;
    staleOperations += 1;
    return true;
  };

  return {
    findOne: async (filter: Filter & { _id: string }) => {
      await interleave();
      if (stale()) return null;
      const doc = store.get(key(filter._id));
      return doc !== undefined && matches(doc, filter) ? structuredClone(doc) : null;
    },

    find: (filter: Filter) => ({
      toArray: async () => {
        await interleave();
        if (stale()) return [];
        return [...store.entries()]
          .filter(([k, v]) => k.startsWith(`${name}/`) && matches(v, filter))
          .map(([, v]) => structuredClone(v));
      },
    }),

    insertOne: async (doc: Doc) => {
      await interleave();
      if (stale()) return { acknowledged: false, insertedId: null };
      generatedIds += 1;
      const id = doc._id ?? `generated-${generatedIds}`;
      if (doc._id !== undefined && store.has(key(id))) throw duplicateKey();
      store.set(key(id), structuredClone({ ...doc, _id: id }));
      return { acknowledged: true, insertedId: id };
    },

    /**
     * Mongo's conditional upsert, including the part the spend ceiling relies
     * on: when the filter does not match the document that is there, the
     * upsert falls through to an insert and collides on `_id`. counters.ts
     * reads that collision as "we are at the cap", so a mock that returned
     * null instead would exercise a different branch than production does.
     */
    findOneAndUpdate: async (
      filter: Filter & { _id: string },
      update: Record<string, Record<string, unknown>>,
      options?: { upsert?: boolean },
    ) => {
      await interleave();
      // Null rather than a write. counters.ts reads null as "at the cap",
      // which is the fail-closed direction for an operation nobody is
      // waiting on any more.
      if (stale()) return null;
      if (options?.upsert !== true) {
        throw new Error("load-test mock: findOneAndUpdate without upsert is not modelled");
      }
      const existing = store.get(key(filter._id));
      if (existing !== undefined && !matches(existing, filter)) throw duplicateKey();
      const next = applyUpdate(existing, filter._id, update);
      store.set(key(filter._id), next);
      return structuredClone(next);
    },

    updateOne: async (
      filter: Filter & { _id: string },
      update: Record<string, Record<string, unknown>>,
      options?: { upsert?: boolean },
    ) => {
      await interleave();
      if (stale()) return { acknowledged: false, matchedCount: 0 };
      const existing = store.get(key(filter._id));
      if (existing === undefined) {
        if (options?.upsert !== true) return { acknowledged: true, matchedCount: 0 };
        store.set(key(filter._id), applyUpdate(undefined, filter._id, update));
        return { acknowledged: true, matchedCount: 0, upsertedCount: 1 };
      }
      if (!matches(existing, filter)) {
        if (options?.upsert === true) throw duplicateKey();
        return { acknowledged: true, matchedCount: 0 };
      }
      store.set(key(filter._id), applyUpdate(existing, filter._id, update));
      return { acknowledged: true, matchedCount: 1 };
    },

    deleteOne: async (filter: { _id: string }) => {
      await interleave();
      if (stale()) return { acknowledged: false, deletedCount: 0 };
      const had = store.delete(key(filter._id));
      return { acknowledged: true, deletedCount: had ? 1 : 0 };
    },

    deleteMany: async (filter: Filter) => {
      await interleave();
      if (stale()) return { acknowledged: false, deletedCount: 0 };
      let deletedCount = 0;
      for (const [k, v] of [...store]) {
        if (k.startsWith(`${name}/`) && matches(v, filter)) {
          store.delete(k);
          deletedCount += 1;
        }
      }
      return { acknowledged: true, deletedCount };
    },

    createIndex: () => Promise.resolve("ok"),
  };
}

vi.mock("../db.js", () => ({
  getDb: () => {
    // Stamped here, at the start of the operation, rather than read when it
    // finishes. See the note on storeGeneration.
    const generation = storeGeneration;
    return Promise.resolve({
      collection: (name: string) => collection(name, generation),
      command: () => Promise.resolve({ ok: 1 }),
    });
  },
}));

/* ── substitution 2: the vendor SDK ─────────────────────────────────────── */

/**
 * What the fake recognizer does. Mutable so a test can take the provider down
 * and bring it back up without rebuilding the server — the recovery has to
 * happen to the same provider instance whose failures opened the breaker, or
 * it is not a recovery.
 */
let sdkBehaviour: "ok" | "reject" = "ok";
/** Provider calls made. The breaker's whole value is keeping this small. */
let sdkCalls = 0;

const RESULT_REASON = { RecognizedSpeech: 3, NoMatch: 0, Canceled: 1 };

function scoredJson(): string {
  return JSON.stringify({
    NBest: [
      {
        Display: "Bonjour",
        PronunciationAssessment: { AccuracyScore: 88, FluencyScore: 90, CompletenessScore: 100, PronScore: 89 },
        Words: [
          {
            Word: "bonjour",
            PronunciationAssessment: { AccuracyScore: 88, ErrorType: "None" },
            Phonemes: [{ Phoneme: "b", PronunciationAssessment: { AccuracyScore: 90 } }],
            Syllables: [{ Grapheme: "bon", PronunciationAssessment: { AccuracyScore: 88 }, Offset: 0, Duration: 100 }],
          },
        ],
      },
    ],
  });
}

vi.mock("microsoft-cognitiveservices-speech-sdk", () => {
  class SpeechRecognizer {
    public recognizeOnceAsync(resolve: (r: unknown) => void, reject: (e: unknown) => void): void {
      sdkCalls += 1;
      const behaviour = sdkBehaviour;
      // Settled off the current tick, so a burst of requests interleaves the
      // way it would against a real network rather than completing in
      // creation order.
      setImmediate(() => {
        if (behaviour === "reject") {
          reject(new Error("connection reset by peer"));
          return;
        }
        resolve({ reason: RESULT_REASON.RecognizedSpeech, json: scoredJson(), text: "Bonjour" });
      });
    }

    public close(): void {
      /* nothing to close on a fake recognizer */
    }
  }

  return {
    default: {
      SpeechConfig: { fromSubscription: () => ({}) },
      AudioConfig: { fromWavFileInput: () => ({}) },
      PronunciationAssessmentConfig: class {
        public applyTo(): void {
          /* nothing to apply to a fake recognizer */
        }
      },
      PronunciationAssessmentGradingSystem: { HundredMark: 1 },
      PronunciationAssessmentGranularity: { Phoneme: 3 },
      SpeechRecognizer,
      ResultReason: RESULT_REASON,
      CancellationDetails: { fromResult: () => ({ reason: 0, errorDetails: "" }) },
      CancellationReason: { Error: 0 },
    },
  };
});

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/* ── the app, assembled as index.ts assembles it ────────────────────────── */

/**
 * Outside the repository, deliberately.
 *
 * fallbackLog.ts defaults to `join(process.cwd(), "data")`, and `.gitignore`
 * matches `data/` unanchored at any depth — a directory of that name created
 * under the repo by a test run is one git will hide, which is how nine source
 * modules once went missing. The mocked database never fails, so nothing here
 * should trigger a fallback write at all, but the default is not worth relying
 * on for that.
 */
const FALLBACK_DIR = join(tmpdir(), "sonare-load-test-fallback");

/** Env this file touches, restored afterwards so nothing leaks to another file. */
const TOUCHED = [
  "AZURE_SPEECH_KEY",
  "AZURE_SPEECH_REGION",
  "PRONUNCIATION_PROVIDER",
  "MAX_DAILY_SCORING_CALLS",
  "FALLBACK_DIR",
  "SAVE_AUDIO_DIR",
  "LEARNER_TOKEN_SECRET",
] as const;
const ORIGINAL_ENV = new Map<string, string | undefined>(TOUCHED.map((k) => [k, process.env[k]]));

function restoreEnv(): void {
  for (const [key, value] of ORIGINAL_ENV) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

interface Booted {
  base: string;
  close: () => Promise<void>;
  /**
   * The metrics module the running app increments — taken from `boot()`'s own
   * import, never from a static one at the top of this file.
   *
   * `boot()` calls `vi.resetModules()`, so a top-level import would be a
   * *second* instance: a different counter map, a different histogram, and
   * assertions that describe a copy of the source rather than the server that
   * is answering. This project has had four assertions pass that way.
   */
  metrics: {
    snapshot: () => MetricsSnapshot;
    resetMetrics: () => void;
    observeScoringLatency: (providerMs: number, totalMs: number) => void;
  };
  /** Also the running app's instance, for the same reason. */
  counters: {
    reserveScoringCall: (cap: number, when?: Date) => Promise<Reservation>;
  };
  /** Read from the app's own fallbackLog instance, to prove it saw FALLBACK_DIR. */
  fallbackFile: string;
}

async function boot(cap: number): Promise<Booted> {
  process.env.AZURE_SPEECH_KEY = "not-a-real-key-and-never-sent-anywhere";
  process.env.AZURE_SPEECH_REGION = "southeastasia";
  process.env.PRONUNCIATION_PROVIDER = "azure";
  process.env.MAX_DAILY_SCORING_CALLS = String(cap);
  process.env.FALLBACK_DIR = FALLBACK_DIR;
  // Learner audio must never be written by a test run.
  delete process.env.SAVE_AUDIO_DIR;
  // Anonymous traffic throughout, so the per-IP limiter is the one in force
  // and no case here depends on a token secret.
  delete process.env.LEARNER_TOKEN_SECRET;

  vi.resetModules();

  const express = (await import("express")).default;
  const { pronunciationRouter } = await import("../routes/pronunciation.js");
  const { healthRouter } = await import("../routes/health.js");
  const metrics = await import("../infra/metrics.js");
  const counters = await import("../counters.js");
  const { fallbackPath } = await import("../fallbackLog.js");

  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use("/api/v1", pronunciationRouter);
  app.use(healthRouter);

  let server: Server;
  await new Promise<void>((ready) => {
    server = app.listen(0, "127.0.0.1", () => ready());
  });

  return {
    base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`,
    close: () => new Promise<void>((done) => server!.close(() => done())),
    metrics,
    counters,
    fallbackFile: fallbackPath("attempts"),
  };
}

/* ── requests ───────────────────────────────────────────────────────────── */

/** A real WAV, since the route decodes the header before spending anything. */
function wav(seconds: number): Buffer {
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

/**
 * One Blob each, shared by every request in a burst.
 *
 * 480 copies of the oversize body would be a gigabyte of client-side buffers,
 * which would make this test a memory test of `fetch` rather than of the
 * server. A Blob is immutable and re-readable, so one is enough.
 */
const GOOD_AUDIO = new Blob([new Uint8Array(wav(2))], { type: "audio/wav" });
/**
 * Well past the multer ceiling, which at the default MAX_AUDIO_SECONDS of 15
 * is 16000 x 2 x 15 x 1.5 + 1024 = 721,024 bytes. A 60-second WAV is 1.92 MB —
 * the same size the original hand-run probe used, so the case reproduces that
 * afternoon rather than a tidier version of it.
 */
const OVERSIZE_AUDIO = new Blob([new Uint8Array(wav(60))], { type: "audio/wav" });

/**
 * A distinct address per request, counted rather than randomised.
 *
 * The per-IP limiter allows 30 a minute. Random addresses collide by birthday
 * and would turn a 429 into an intermittent failure of a test that is not
 * about rate limiting; counting gives 16.7M distinct addresses and no
 * collisions at all.
 */
function addressFor(index: number): string {
  return `10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`;
}

function scoreForm(audio: Blob): FormData {
  const form = new FormData();
  form.append("audio", audio, "capture.wav");
  form.append("referenceText", "Bonjour, comment allez-vous");
  form.append("language", "fr-FR");
  return form;
}

interface Outcome {
  status: number;
  /** The error code on the wire, or null for a body with no error in it. */
  code: string | null;
}

/**
 * One request, reduced to a status and a code, with every abnormal shape given
 * a name of its own rather than being collapsed into a status number.
 *
 * `expect(status).toBe(400)` tells you a number was wrong and nothing about
 * why — upload.test.ts learned that from a case that failed once under
 * full-suite load and never reproduced. So a body that will not parse, a body
 * that is not there, and a request that never got an answer at all are three
 * distinct labels, and they show up in the tally with their counts. A burst
 * that half-failed and a burst that was refused correctly must not look alike.
 */
async function scoreOnce(base: string, index: number, audio: Blob = GOOD_AUDIO): Promise<Outcome> {
  let res: Response;
  try {
    res = await fetch(`${base}/api/v1/pronunciation`, {
      method: "POST",
      headers: { "x-forwarded-for": addressFor(index) },
      body: scoreForm(audio),
    });
  } catch (err) {
    return { status: 0, code: `no-response:${String(err).slice(0, 60)}` };
  }

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    return { status: res.status, code: `body-failed:${String(err).slice(0, 60)}` };
  }

  if (text.length === 0) return { status: res.status, code: "no-body" };

  try {
    return { status: res.status, code: (JSON.parse(text) as { error?: { code?: string } }).error?.code ?? null };
  } catch {
    return { status: res.status, code: `unparseable:${text.slice(0, 40)}` };
  }
}

/** Every request created before any is awaited — a burst, not a queue. */
function burst(base: string, count: number, audio: Blob = GOOD_AUDIO, from = 0): Promise<Outcome[]> {
  return Promise.all(Array.from({ length: count }, (_, i) => scoreOnce(base, from + i, audio)));
}

/**
 * Outcomes grouped by `status/code`.
 *
 * Asserting on the whole tally rather than on a count of successes: a wrong
 * refusal and a right one both leave "5 succeeded" true, and the difference
 * between AUDIO_TOO_LONG and an unexpected 500 is the difference between a
 * guard working and a server falling over. When this fails, the message names
 * every shape that came back and how many of each.
 */
function tally(outcomes: Outcome[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of outcomes) {
    const label = `${o.status}/${o.code ?? "ok"}`;
    out[label] = (out[label] ?? 0) + 1;
  }
  return out;
}

/**
 * A burst, split by what the client actually ended up with.
 *
 * The split exists because of something the hand-run probe could not have seen
 * and this file measured. When the server refuses an oversize upload it
 * answers *before* reading the body, so the socket is torn down with bytes
 * still in flight — and past a certain width a large share of clients get a
 * write error instead of the answer. Measured here: 1,134 of 2,000 concurrent
 * 1.92 MB uploads never got an answer, while at 480 every one did, across six
 * runs. The same thing happens more mildly on a successful burst — 70 of 2,000
 * scored requests lost their response at 2,000 wide.
 *
 * That is ordinary HTTP at a width no browser will produce, not a server
 * fault, and crucially it is not the guard failing: nothing got through and
 * nothing was billed either way. So it is counted and printed rather than
 * asserted against, and the assertions are over `answered` — what the server
 * did answer, every one of which has to be right.
 *
 * The consequence for the counter assertions is the important part: the
 * *client's* count of successes is a lower bound on what the server processed
 * and never the figure to compare a counter against. What has to agree exactly
 * is the server's own counters with each other.
 */
function burstReport(outcomes: Outcome[]): {
  answered: Outcome[];
  ok: number;
  noResponse: number;
  truncated: number;
  describe: string;
} {
  /**
   * A response counts as answered only when its body was read to the end.
   *
   * Three shapes were observed once the socket teardown was in play, and they
   * are all the same phenomenon rather than three problems: a body of zero
   * length (`no-body`), a body whose stream was cut off part-way
   * (`body-failed: TypeError: terminated`), and no response at all
   * (`no-response`). `unparseable:` deliberately stays on the answered side —
   * a complete body that is not the JSON contract is a real finding and has
   * to fail a tally rather than be filtered into a footnote.
   */
  const truncated = outcomes.filter((o) => o.code === "no-body" || o.code?.startsWith("body-failed:") === true);
  const noResponse = outcomes.filter((o) => o.status === 0);
  const answered = outcomes.filter((o) => !truncated.includes(o) && !noResponse.includes(o));
  return {
    answered,
    ok: outcomes.filter((o) => o.status === 200).length,
    noResponse: noResponse.length,
    truncated: truncated.length,
    describe:
      `${outcomes.length} sent, ${answered.length} answered in full, ` +
      `${truncated.length} answered with a truncated body, ` +
      `${noResponse.length} never answered (socket torn down mid-upload)`,
  };
}

/**
 * Yields until `predicate` holds, or until a turn budget runs out.
 *
 * Deliberately counted in event-loop turns rather than milliseconds. Several
 * things the route does happen *after* the response — the attempt write, the
 * skills rollup, the diagnostic record — and a test that wants to read one of
 * them has to wait for it without asserting how long a busy laptop may take.
 * Returns whether it got there, so a caller asserts rather than assumes.
 */
async function until(predicate: () => boolean, turns = 20_000): Promise<boolean> {
  for (let i = 0; i < turns; i += 1) {
    if (predicate()) return true;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  return predicate();
}

/** Every diagnostic the app has persisted, from the substituted store. */
function diagnostics(): Array<{ code: string; message: string }> {
  return [...store.entries()]
    .filter(([key]) => key.startsWith("diagnostics/"))
    .map(([, doc]) => ({ code: String(doc.code), message: String(doc.message) }));
}

/** The day's spend document, as the app wrote it. */
function spendCounter(): { calls: number; billableSeconds: number } | undefined {
  for (const [key, doc] of store) {
    if (key.startsWith("counters/spend:")) {
      return { calls: doc.calls as number, billableSeconds: doc.billableSeconds as number };
    }
  }
  return undefined;
}

function freshStore(): void {
  store = new Map();
  // Everything already in flight now belongs to the store that just went
  // away, and will be dropped rather than landing in this one.
  storeGeneration += 1;
  sdkBehaviour = "ok";
  sdkCalls = 0;
}

/* ══ 1. the metrics reservoir ═══════════════════════════════════════════════ */

describe("the metrics reservoir under sustained traffic", () => {
  let app: Booted;

  beforeAll(async () => {
    app = await boot(1_000_000);
  });

  afterAll(async () => {
    await app.close();
    restoreEnv();
  });

  beforeEach(() => {
    freshStore();
    app.metrics.resetMetrics();
  });

  it("samples uniformly rather than keeping the most recent window", () => {
    /**
     * The distinction metrics.ts spends a paragraph on: "A plain ring buffer
     * would make p99 describe only the last thousand calls." Every
     * single-call test in this suite passes against a ring buffer, and so does
     * every count in it. Only sustained traffic separates the two.
     *
     * A hundred thousand fast calls, then a thousand slow ones. A ring buffer
     * of a thousand holds *nothing but* the slow ones, so its median is 900.
     * A uniform reservoir expects about ten of them among its thousand
     * samples, so its median is 1. Three orders of magnitude apart, and the
     * arithmetic leaves no room for luck: the median could only move if ~500
     * of the 1000 slots held a late sample against an expectation of ~10,
     * which is roughly a 100-sigma event.
     */
    const { snapshot, observeScoringLatency } = app.metrics;

    for (let i = 0; i < 100_000; i += 1) observeScoringLatency(1, 1);
    for (let i = 0; i < 1_000; i += 1) observeScoringLatency(900, 900);

    expect(snapshot().latency.provider.p50).toBe(1);
    expect(snapshot().latency.provider.p95).toBe(1);
    // The mean, unlike the percentiles, is exact over everything seen —
    // 101000 calls of which 1000 were 900ms.
    expect(snapshot().latency.provider.mean).toBe(Number(((100_000 + 900_000) / 101_000).toFixed(1)));
  });

  it("counts every call while keeping only a sample of them", () => {
    const { snapshot, observeScoringLatency } = app.metrics;

    for (let i = 1; i <= 250_000; i += 1) observeScoringLatency(i, i);

    // `count` is everything seen; `sampleSize` is what the percentiles were
    // computed over. Conflating the two is how a percentile ends up described
    // as covering every call.
    expect(snapshot().latency.provider.count).toBe(250_000);
    expect(snapshot().latency.sampleSize).toBeLessThan(250_000);
    // Every percentile is still drawn from the observed range, so the sample
    // was replaced rather than corrupted.
    for (const p of [snapshot().latency.provider.p50, snapshot().latency.provider.p95, snapshot().latency.provider.p99]) {
      expect(p).not.toBeNull();
      expect(p as number).toBeGreaterThanOrEqual(1);
      expect(p as number).toBeLessThanOrEqual(250_000);
    }
  });

  it("does not grow the heap with request count", () => {
    /**
     * The one heap assertion in this file, with the arithmetic for its
     * threshold rather than a number chosen by feel.
     *
     * `observe()` allocates nothing on the bounded path: the reservoir is full
     * after the first thousand calls and every later one is a single
     * `samples[index] = ms` into an array that already exists. So the expected
     * growth across four million calls is zero, and what is being measured is
     * noise.
     *
     * An unbounded array — the leak metrics.ts says it exists to avoid — holds
     * four million numbers per histogram, two histograms deep.
     *
     * Both sides were measured on this machine before the threshold was
     * picked, against a forced collection:
     *
     *   bounded, as shipped   -2,336 bytes, identical across three runs
     *   unbounded (push-only) +78,315,304 bytes
     *
     * So 4 MB sits four orders of magnitude above the noise and twenty times
     * below the smallest form of the leak. Without a forced collection the
     * bounded reading rises to about 11 MB of uncollected garbage, so the
     * fallback ceiling is 40 MB — much weaker, still an order of magnitude
     * below the leak, and never a coin flip.
     *
     * What this can prove: retention that scales with request count is not
     * happening. What it cannot: that nothing leaks at all, that a leak too
     * small or too slow to show in four million calls is absent, or anything
     * whatsoever about native or external memory — `heapUsed` does not see
     * Buffers, sockets or V8's own metaspace.
     */
    const { observeScoringLatency } = app.metrics;
    const CALLS = 4_000_000;

    // Saturate first, so the reservoir's own one-off thousand-element
    // allocation lands in the baseline rather than in the measurement.
    for (let i = 1; i <= 50_000; i += 1) observeScoringLatency(i, i);
    const before = collectedHeap();

    for (let i = 1; i <= CALLS; i += 1) observeScoringLatency(i % 4096, i % 4096);
    const after = collectedHeap();

    const ceiling = (forcedCollectionAvailable() ? 4 : 40) * 1024 * 1024;
    expect(after.bytes - before.bytes).toBeLessThan(ceiling);
    // Both readings came from the same measurement mode, or the difference
    // between them describes nothing.
    expect(after.forced).toBe(before.forced);
    // And the sample really did keep turning over, so the loop was not
    // optimised away.
    expect(app.metrics.snapshot().latency.provider.count).toBe(CALLS + 50_000);
  });

  it("moves the counters by exactly the number of requests served", async () => {
    const outcomes = await burst(app.base, 300);
    const snap = app.metrics.snapshot();

    expect(tally(outcomes)).toEqual({ "200/ok": 300 });
    // Exact, not "at least": a double-count here doubles every rate derived
    // from it, including the thresholds infra/alerts.ts evaluates.
    expect(snap.counters["scoring.calls"]).toBe(300);
    expect(snap.latency.provider.count).toBe(300);
    expect(snap.latency.total.count).toBe(300);
    expect(snap.counters["scoring.indeterminate"]).toBeUndefined();
    expect(snap.rates.indeterminate).toBe(0);
    /**
     * Read from the app's own fallbackLog instance rather than from a second
     * import, so this is a claim about where the running server would write
     * and not about what this file set in `process.env`. Nothing under the
     * repository, whatever happens above.
     */
    expect(app.fallbackFile.startsWith(FALLBACK_DIR)).toBe(true);
  });
});

/**
 * Whether a collection can be forced, which decides how strong a heap
 * assertion is allowed to be.
 *
 * `globalThis.gc` exists under `--expose-gc`, which `npm run soak` sets. When
 * it is absent, `--expose-gc` can still be turned on for the running isolate
 * through `node:v8` and a throwaway `node:vm` context — both core modules, so
 * no dependency, and the flag is turned back off immediately afterwards. This
 * is the difference between a heap number that means something and one that
 * is mostly uncollected garbage: measured here, a forced collection makes the
 * reading reproducible to within a couple of kilobytes across runs, where the
 * unforced one wanders by ten megabytes.
 */
let forcedCollection: (() => void) | null | undefined;

function forcedCollectionAvailable(): boolean {
  if (forcedCollection === undefined) {
    const native = (globalThis as { gc?: () => void }).gc;
    if (native !== undefined) {
      forcedCollection = native;
    } else {
      try {
        v8.setFlagsFromString("--expose-gc");
        const exposed = vm.runInNewContext("gc") as unknown;
        forcedCollection = typeof exposed === "function" ? (exposed as () => void) : null;
      } catch {
        forcedCollection = null;
      } finally {
        v8.setFlagsFromString("--no-expose-gc");
      }
    }
  }
  return forcedCollection !== null;
}

/** A heap reading, and whether a collection was forced before taking it. */
function collectedHeap(): { bytes: number; forced: boolean } {
  const forced = forcedCollectionAvailable();
  if (forced && forcedCollection) {
    // Twice: the first pass frees, the second sweeps what the first made
    // unreachable.
    forcedCollection();
    forcedCollection();
    return { bytes: process.memoryUsage().heapUsed, forced: true };
  }
  let lowest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 4; i += 1) lowest = Math.min(lowest, process.memoryUsage().heapUsed);
  return { bytes: lowest, forced: false };
}

/* ══ 2. the daily spend counter under concurrency ═══════════════════════════ */

describe("the daily spend counter under concurrency", () => {
  const CAP = 25;
  const BURST = 200;
  let app: Booted;

  beforeAll(async () => {
    app = await boot(CAP);
  });

  afterAll(async () => {
    await app.close();
    restoreEnv();
  });

  beforeEach(() => {
    freshStore();
    app.metrics.resetMetrics();
  });

  it("holds the cap when two hundred reservations run truly simultaneously", async () => {
    /**
     * The atomicity itself, driven at the reservation rather than over HTTP.
     *
     * This case exists because the HTTP burst below **does not** catch a
     * check-then-increment implementation, and that was measured rather than
     * assumed: replacing counters.ts's conditional `$inc` with a `findOne`
     * followed by an unconditional one left the 200-request HTTP burst
     * entirely green. The reason is that an HTTP request is not cheap — a
     * multipart parse, a WAV header decode and two limiter round trips happen
     * first — so 200 requests arrive at the reservation staggered enough that
     * each one's read-then-write completes before the next one starts. The
     * race is real and the transport was hiding it.
     *
     * Two hundred calls straight into `reserveScoringCall` do overlap: each is
     * two awaits, all two hundred are created before any is awaited, and the
     * substituted database yields between operations (see `interleave`). Under
     * check-then-increment all two hundred read `calls: 0` and all two hundred
     * proceed. Under the shipped version exactly CAP do.
     *
     * Taken from `boot()`'s own module instance, so this is the counter the
     * running server reserves against and not a second copy of it.
     */
    const results = await Promise.all(Array.from({ length: BURST }, () => app.counters.reserveScoringCall(CAP)));

    expect(results.filter((r) => r.allowed)).toHaveLength(CAP);
    expect(results.filter((r) => !r.allowed && r.reason === "at-cap")).toHaveLength(BURST - CAP);
    // Never a reservation that was refused as "unavailable" — that is the
    // fail-closed path for a broken database, and this one is healthy.
    expect(results.filter((r) => !r.allowed && r.reason === "unavailable")).toHaveLength(0);
    // And exactly CAP increments landed on the shared document.
    expect(spendCounter()?.calls).toBe(CAP);
  });

  it("allows exactly the cap out of two hundred simultaneous requests", async () => {
    /**
     * The same ceiling, end to end through the real route.
     *
     * What this adds over the case above is everything between the socket and
     * the counter: that `withDailyCap` is actually in the provider chain, that
     * a refusal becomes the right status and code on the wire, that the
     * refusal is counted, and that a refused request costs nothing at the
     * vendor. What it does *not* add is the race — see the case above.
     *
     * That the cap in force is this file's CAP and not the 2000 default is
     * proved by the assertion itself: a second module instance reading the
     * default would let all 200 through, so the boundary landing exactly on 25
     * is the only way this passes.
     */
    const outcomes = await burst(app.base, BURST);

    expect(tally(outcomes)).toEqual({
      "200/ok": CAP,
      // withDailyCap's refusal: PROVIDER_UNAVAILABLE in the server domain,
      // which AppError maps to 502.
      "502/PROVIDER_UNAVAILABLE": BURST - CAP,
    });
    // No lost increment and no double-charge: the shared document holds
    // exactly one count per allowed call.
    expect(spendCounter()?.calls).toBe(CAP);
    expect(app.metrics.snapshot().counters["scoring.refused.cap"]).toBe(BURST - CAP);
    expect(app.metrics.snapshot().counters["scoring.calls"]).toBe(CAP);
    // And exactly the allowed calls reached the provider — the refusals cost
    // nothing at the vendor.
    expect(sdkCalls).toBe(CAP);
  });

  it("charges each call once when every request is under the cap", async () => {
    /**
     * The other half, and the one a cap test usually forgets. A ceiling that
     * over-counts is also broken: it would refuse learners early and report a
     * spend nobody incurred. Two hundred requests under a cap of a thousand
     * must leave exactly two hundred counted, and 200 x 2s of audio must be
     * billed as exactly 400 seconds.
     */
    await app.close();
    app = await boot(1_000);
    freshStore();
    app.metrics.resetMetrics();

    /**
     * Simultaneously first, for the same reason the case above is: an
     * increment lost to a race shows up as a count below the number of
     * callers, and only overlapping callers can lose one.
     */
    const simultaneous = await Promise.all(
      Array.from({ length: BURST }, () => app.counters.reserveScoringCall(1_000)),
    );
    expect(simultaneous.filter((r) => r.allowed)).toHaveLength(BURST);
    expect(spendCounter()?.calls).toBe(BURST);
    // Each reservation was handed a distinct running total, so no two callers
    // were told they were the same call.
    expect(new Set(simultaneous.map((r) => (r.allowed ? r.calls : null))).size).toBe(BURST);

    freshStore();
    app.metrics.resetMetrics();

    const outcomes = await burst(app.base, BURST);

    expect(tally(outcomes)).toEqual({ "200/ok": BURST });
    expect(spendCounter()?.calls).toBe(BURST);
    // 200 takes of two seconds each, billed as 400 whole seconds — the
    // per-request round-up counters.ts documents, applied 200 times without
    // drifting.
    expect(spendCounter()?.billableSeconds).toBe(BURST * 2);
    expect(sdkCalls).toBe(BURST);
    // And every server-side count of a scored call agrees with every other
    // one. This is the form the soak tier uses at ten times the width, where
    // the client's own count stops being trustworthy.
    const snap = app.metrics.snapshot();
    expect(snap.counters["scoring.calls"]).toBe(BURST);
    expect(snap.latency.provider.count).toBe(BURST);
  });
});

/* ══ 3. the breaker under a flood ══════════════════════════════════════════ */

describe("the circuit breaker under a flood", () => {
  /**
   * Constants read off azureSpeech.ts rather than guessed, so a change there
   * fails this file loudly instead of silently making it vacuous.
   *
   * CIRCUIT_FAILURE_THRESHOLD and CIRCUIT_COOLDOWN_MS are module-private, so
   * they are restated here; MAX_PROVIDER_ATTEMPTS is exported and is imported
   * inside the test to keep the two in step.
   */
  const FAILURES_TO_OPEN = 3;
  const COOLDOWN_MS = 30_000;

  let app: Booted;
  let clockOffsetMs = 0;

  beforeEach(async () => {
    /**
     * A fresh app per case. The breaker's state lives on one
     * AzureSpeechProvider instance, and a case that inherited a half-open
     * breaker from the case before it would be testing an order rather than a
     * behaviour.
     */
    app = await boot(1_000_000);
    freshStore();
    app.metrics.resetMetrics();

    /**
     * Time is shifted rather than faked.
     *
     * The cooldown is thirty real seconds and is not configurable, so a
     * recovery case has to move the clock. Only `Date.now` is redirected, and
     * only by an offset — which is all the breaker reads
     * (`Date.now() < circuitOpenUntil`). Full fake timers would also stop the
     * 400ms retry backoff, the recognition timeout and Node's own socket
     * timers, which is a much larger blast radius for one comparison.
     */
    clockOffsetMs = 0;
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffsetMs);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    restoreEnv();
  });

  /** Failed calls, one at a time, which is what the breaker counts. */
  async function driveToFailure(from: number): Promise<Outcome[]> {
    const out: Outcome[] = [];
    for (let i = 0; i < FAILURES_TO_OPEN; i += 1) out.push(await scoreOnce(app.base, from + i));
    return out;
  }

  it("opens after three failed calls and then absorbs a flood at no provider cost", async () => {
    const { MAX_PROVIDER_ATTEMPTS } = await import("./azureSpeech.js");
    sdkBehaviour = "reject";

    const opening = await driveToFailure(0);

    expect(tally(opening)).toEqual({ "502/PROVIDER_REJECTED": FAILURES_TO_OPEN });
    // One failure per *call*, not per attempt — so three failed calls cost six
    // provider calls with one retry each. azureSpeech.ts states that price
    // explicitly; this is it, measured.
    expect(sdkCalls).toBe(FAILURES_TO_OPEN * MAX_PROVIDER_ATTEMPTS);

    const callsBeforeFlood = sdkCalls;
    const flood = await burst(app.base, 200, GOOD_AUDIO, 100);

    // Every one of the 200 refused, and refused by the breaker rather than by
    // the vendor: this is the whole point of having one.
    expect(tally(flood)).toEqual({ "502/PROVIDER_UNAVAILABLE": 200 });
    expect(sdkCalls).toBe(callsBeforeFlood);

    /**
     * And the cost that is *not* zero, pinned so it cannot change quietly.
     *
     * `withDailyCap` reserves against the shared daily counter before it calls
     * the provider (services/index.ts), and the breaker refuses inside the
     * provider — so every one of those 203 refused requests still claimed a
     * day's worth of allowance for a call that never happened. Six provider
     * calls, 203 charges. This is a real defect, reported rather than smoothed
     * over, and this assertion is what makes it visible.
     */
    expect(spendCounter()?.calls).toBe(FAILURES_TO_OPEN + 200);
    // Zero billable seconds against 203 charges: the field is only there
    // because reserveScoringCall's `$setOnInsert` created it, and nothing ever
    // recorded an outcome because nothing ever reached the provider.
    expect(spendCounter()?.billableSeconds).toBe(0);
  });

  it("lets a call through once the cooldown expires, and closes on success", async () => {
    const { MAX_PROVIDER_ATTEMPTS } = await import("./azureSpeech.js");
    sdkBehaviour = "reject";
    await driveToFailure(0);
    const whileOpen = sdkCalls;

    // Still inside the window: refused without touching the provider.
    expect((await scoreOnce(app.base, 50)).code).toBe("PROVIDER_UNAVAILABLE");
    expect(sdkCalls).toBe(whileOpen);

    // Past it, and the provider is healthy again.
    clockOffsetMs = COOLDOWN_MS + 1_000;
    sdkBehaviour = "ok";

    const first = await scoreOnce(app.base, 60);
    expect(first).toEqual({ status: 200, code: null });
    expect(sdkCalls).toBe(whileOpen + 1);

    /**
     * Closed, not merely expired. The distinction matters: `consecutiveFailures`
     * is only cleared by a success, so a breaker that had expired without
     * closing would re-open on the very next failure. Twenty more calls
     * through, one provider call each, is what closed looks like.
     */
    const after = await burst(app.base, 20, GOOD_AUDIO, 200);
    expect(tally(after)).toEqual({ "200/ok": 20 });
    expect(sdkCalls).toBe(whileOpen + 21);
    // No retries anywhere in that recovery: a retried call would show as two
    // provider calls for one request, and as this counter.
    expect(app.metrics.snapshot().counters["scoring.provider.retried"]).toBe(FAILURES_TO_OPEN);
    // The three opening failures each cost MAX_PROVIDER_ATTEMPTS calls, and
    // nothing since has retried.
    expect(whileOpen).toBe(FAILURES_TO_OPEN * MAX_PROVIDER_ATTEMPTS);
  });

  it("re-opens on the first failure after the cooldown, spending one call to find out", async () => {
    /**
     * The half-open behaviour, which falls out of the implementation rather
     * than being written down in it: the cooldown expiring does not reset
     * `consecutiveFailures`, so the first call after it is a single probe and
     * one more failure puts the breaker straight back to open.
     *
     * Worth pinning because it is the property that makes a long outage cheap.
     * If expiry reset the counter, every cooldown would buy the provider three
     * more failed calls — six with the retry — and a day-long outage would
     * cost thousands.
     */
    const { MAX_PROVIDER_ATTEMPTS } = await import("./azureSpeech.js");
    sdkBehaviour = "reject";
    await driveToFailure(0);
    const whileOpen = sdkCalls;

    clockOffsetMs = COOLDOWN_MS + 1_000;

    const probe = await scoreOnce(app.base, 70);
    expect(probe.code).toBe("PROVIDER_REJECTED");
    expect(sdkCalls).toBe(whileOpen + MAX_PROVIDER_ATTEMPTS);

    // Straight back to open — the next hundred cost nothing.
    const closed = await burst(app.base, 100, GOOD_AUDIO, 300);
    expect(tally(closed)).toEqual({ "502/PROVIDER_UNAVAILABLE": 100 });
    expect(sdkCalls).toBe(whileOpen + MAX_PROVIDER_ATTEMPTS);
  });

  it("reports an error rate of zero while every call is failing", async () => {
    /**
     * Not a property being defended — a defect being pinned.
     *
     * `rates.error` divides `scoring.errors` by `scoring.calls`, and
     * **nothing in the server ever increments `scoring.errors`**. It is
     * declared in metrics.ts's `CounterName` and never used, so the figure
     * infra/alerts.ts and /metrics report is 0 whenever anything has succeeded
     * and null otherwise — never anything else, whatever is going wrong.
     *
     * metrics.ts is explicit that "a 0% indeterminate rate on a server that
     * has scored nothing is not good news", and this is the same failure in
     * the neighbouring field: during a total provider outage the error rate
     * reads as null, and during a partial one it reads as exactly zero.
     *
     * Pinned rather than fixed: incrementing a counter is a change to the
     * metrics layer, and this commit is about measuring what the server does.
     * The assertion fails the moment somebody wires it up, which is the point.
     */
    sdkBehaviour = "ok";
    await burst(app.base, 10);
    sdkBehaviour = "reject";
    // One failed call is enough to make the point, and leaves the breaker
    // closed — this is about the counter, not about the breaker.
    expect((await scoreOnce(app.base, 20)).code).toBe("PROVIDER_REJECTED");

    const snap = app.metrics.snapshot();
    expect(snap.counters["scoring.calls"]).toBe(10);
    expect(snap.counters["scoring.errors"]).toBeUndefined();
    expect(snap.rates.error).toBe(0);
  });
});

/* ══ 4. the 480-upload probe, made runnable ════════════════════════════════ */

describe("480 concurrent oversize uploads", () => {
  let app: Booted;

  beforeAll(async () => {
    app = await boot(1_000_000);
  });

  afterAll(async () => {
    await app.close();
    restoreEnv();
  });

  beforeEach(() => {
    freshStore();
    app.metrics.resetMetrics();
  });

  it("refuses all 480, spends nothing, and is still serving afterwards", async () => {
    /**
     * The hand-run probe this replaces sent 480 concurrent oversize uploads
     * and reported that all 480 were refused. What it could not report,
     * because nobody was reading the server's own numbers at the time, is the
     * part that actually matters: whether any of them reached the provider,
     * whether any of them was charged against the day's spend, and whether the
     * process was still healthy at the end.
     *
     * Storage is `memoryStorage`, so the ceiling in middleware/upload.ts is
     * the only thing between 480 x 1.92 MB of attacker-chosen bytes and an
     * out-of-memory kill. That is why the case is 480 and not 5.
     */
    const outcomes = await burst(app.base, 480, OVERSIZE_AUDIO);
    const report = burstReport(outcomes);
    process.stdout.write(`\n480-upload probe: ${report.describe}\n\n`);

    /**
     * Nothing got through, and nothing was spent. This is what the case exists
     * for and it is exact: no success anywhere, no provider call, no spend
     * reservation, no scored attempt.
     */
    expect(outcomes.filter((o) => o.status === 200)).toEqual([]);
    expect(sdkCalls).toBe(0);
    expect(spendCounter()).toBeUndefined();
    expect(app.metrics.snapshot().counters["scoring.calls"]).toBeUndefined();

    /**
     * Every refusal the server answered carried the right reason — one shape
     * for all of them, with the count in the failure message when it is not.
     *
     * And the status is **400**, not the 413 the probe was remembered as
     * returning. The route builds an `AUDIO_TOO_LONG` AppError with no
     * explicit status (routes/pronunciation.ts), and AppError defaults a
     * client-domain error to 400 — so the multipart ceiling answers 400 while
     * express.json()'s own body ceiling answers 413 for the same class of
     * refusal on every other write route (asserted in
     * routes/security.test.ts). Recorded as measured rather than as
     * remembered, and reported as a finding: 413 is the semantically right
     * answer, and the two paths disagree.
     */
    expect(tally(report.answered)).toEqual({ "400/AUDIO_TOO_LONG": report.answered.length });

    /**
     * And the server answered essentially all of them.
     *
     * Measured at 480 across six runs: 480 answered, every time. The floor is
     * half rather than all because the failure mode above it is a torn-down
     * socket rather than a broken guard, and a load case that fails when a
     * machine is busy is one people learn to skip. A regression that stopped
     * answering — a hang, a crash, a queue that never drains — still falls
     * through this.
     */
    expect(report.answered.length).toBeGreaterThan(240);

    /**
     * Refused **at the transport**, which is the whole point and the one thing
     * the wire response cannot tell you.
     *
     * This assertion exists because removing `fileSize` from the multer limits
     * altogether left every other assertion in this case green, which was
     * measured rather than guessed. Without the ceiling, all 1.92 MB of each
     * upload is buffered into this process's memory, the WAV header is parsed,
     * and `assertDuration` refuses it — with the *same* `AUDIO_TOO_LONG` code,
     * the *same* 400, and the *same* user-facing sentence. The memory guard
     * can be deleted entirely without changing a single byte on the wire.
     *
     * What does differ is the internal message on the diagnostic the route
     * persists: `upload rejected: MulterError...` when the ceiling fired,
     * `duration 60.00s above maximum 15s` when it did not. So the trail is
     * where this is checked. Depending on that string is a real cost and it is
     * worth it — the alternative is a case about a memory guard that passes
     * with the memory guard removed.
     */
    expect(await until(() => diagnostics().length >= report.answered.length)).toBe(true);
    const reasons = new Set(diagnostics().map((d) => `${d.code}/${d.message.split(":")[0]}`));
    expect(reasons).toEqual(new Set(["AUDIO_TOO_LONG/upload rejected"]));
    /**
     * And the counter that should have moved and does not.
     *
     * `upload.rejected` is declared in metrics.ts's `CounterName` and is never
     * incremented anywhere in the server, so the one event this whole case is
     * about is invisible on /metrics. Pinned, and reported.
     */
    expect(app.metrics.snapshot().counters["upload.rejected"]).toBeUndefined();

    // Still alive, still ready, and still able to score — a refusal that
    // leaves the process wedged is not a refusal.
    const alive = await fetch(`${app.base}/healthz`);
    expect(alive.status).toBe(200);
    expect(await scoreOnce(app.base, 900)).toEqual({ status: 200, code: null });
  });
});

/* ══ 5. the soak — human-run, `npm run soak` ═══════════════════════════════ */

/**
 * Everything too slow or too noisy for `npm test`.
 *
 * Skipped unless SOAK=1, which `npm run soak` sets along with `--expose-gc`
 * and the wave/burst knobs. In a default run these appear as skipped rather
 * than as absent, so nobody has to remember they exist.
 *
 * ── what the heap series can and cannot prove ──────────────────────────────
 * It can catch retention that scales with request count. Ten thousand
 * requests at a kilobyte each is ten megabytes, and a series that climbs
 * monotonically across eighteen waves is not noise.
 *
 * It cannot prove there is no leak. `heapUsed` is blind to native and external
 * memory — Buffers, sockets and V8's own metaspace are all outside it — so a
 * leak in the upload path's Buffers would not show here at all. It cannot see
 * a leak of a few bytes per request, which is real and would take weeks to
 * matter. And it cannot distinguish "retained" from "not yet collected" any
 * better than the collection it forces, which V8 is free to treat as advice.
 *
 * It is also measuring a server whose database is an in-memory Map that keeps
 * every document written to it. That store is a genuine and growing retention
 * source and it is not the server's, so it is cleared between waves — the
 * series below describes the app's own retention with the substitution's
 * removed, which is the only honest reading available without a mongod.
 */
const SOAKING = process.env.SOAK === "1";

function soakNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

describe.skipIf(!SOAKING)("the soak", () => {
  const WAVES = soakNumber("SOAK_WAVES", 30);
  const PER_WAVE = soakNumber("SOAK_REQUESTS_PER_WAVE", 1_000);
  const CONCURRENCY = soakNumber("SOAK_CONCURRENCY", 2_000);

  let app: Booted;

  beforeAll(async () => {
    app = await boot(50_000_000);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    restoreEnv();
  });

  beforeEach(() => {
    freshStore();
    app.metrics.resetMetrics();
  });

  /**
   * Waves discarded before the heap is believed.
   *
   * Five, measured rather than chosen. The series at every width tried ramps
   * for about five waves and is then flat to within half a megabyte — that
   * ramp is `fetch`'s connection pool filling to the burst width, the module
   * graph, and JIT compilation, all one-off costs that do not scale with
   * request count. It is a wave count rather than a fraction because it is a
   * wave count in the data: at 8 waves and at 30 the ramp was the same five.
   */
  const WARMUP_WAVES = 5;

  it(
    "holds a flat heap across the whole soak",
    async (ctx) => {
      /**
       * A run too narrow to see past the ramp cannot make this claim, so it
       * says so instead of passing. A vacuous green here would be worse than
       * no case at all: somebody would read it as evidence.
       */
      if (WAVES - WARMUP_WAVES < 3) {
        ctx.skip(
          `needs at least ${WARMUP_WAVES + 3} waves to see past the warm-up ramp, got ${WAVES}` +
            ` — run npm run soak without --waves, or with a larger one`,
        );
      }

      const series: number[] = [];
      let served = 0;

      for (let wave = 0; wave < WAVES; wave += 1) {
        const outcomes = await burst(app.base, PER_WAVE, GOOD_AUDIO, wave * PER_WAVE);
        expect(tally(outcomes)).toEqual({ "200/ok": PER_WAVE });
        served += PER_WAVE;
        // The substituted database keeps every attempt it is handed. That is
        // the mock's memory, not the server's, so it goes before the reading.
        freshStore();
        series.push(collectedHeap().bytes);
      }

      /**
       * The warm-up is discarded, and not to make the number look better.
       * The measured series at the default widths is the evidence:
       *
       *   36.0 36.4 49.2 43.5 56.9 | 57.2 57.1 57.2 57.0 57.2 ... 57.6
       *
       * Five waves of growth, then twenty-five flat to within half a megabyte.
       * Including the ramp would have the assertion measuring a connection
       * pool and calling it a leak. The whole series is printed, so a reader
       * can check that the discarded part really was a ramp rather than the
       * beginning of a climb.
       *
       * The comparison over what remains is min-to-max rather than
       * first-to-last, so a wave that spikes and settles is caught instead of
       * being averaged away by the wave after it.
       */
      const measured = series.slice(WARMUP_WAVES);
      const low = Math.min(...measured);
      const high = Math.max(...measured);
      const requestsMeasured = Math.max(0, served - WARMUP_WAVES * PER_WAVE);
      const perRequest = requestsMeasured > 0 ? (high - low) / requestsMeasured : 0;

      /**
       * Two terms, because one number cannot carry both jobs.
       *
       * NOISE is the flat allowance for a garbage-collected heap that wanders
       * regardless of traffic. Measured over the plateau above, the spread is
       * about 0.4 MB, so 4 MB is ten times the observed noise. This
       * term is what stops the case being flaky.
       *
       * PER_REQUEST is the part that scales, and it is what makes the case
       * mean anything: a leak of a quarter-kilobyte per request is 5.6 MB over
       * the default 22,500 measured requests and grows from there, while noise
       * divided by 22,500 is nothing.
       *
       * The consequence, stated because it is the honest limit rather than a
       * detail: at small widths the noise term dominates and this case proves
       * almost nothing. `npm run soak`'s defaults are chosen so the scaling
       * term is in charge, and the line printed below says which term won —
       * a run with `--waves 4 --requests 100` is a smoke test of the harness
       * and not a measurement of anything.
       */
      const NOISE_BYTES = 4 * 1024 * 1024;
      const PER_REQUEST_BYTES = 256;
      const allowance = NOISE_BYTES + requestsMeasured * PER_REQUEST_BYTES;

      // Printed whatever happens, because the series is the finding and the
      // boolean is only a summary of it.
      process.stdout.write(
        [
          "",
          `soak: ${WAVES} waves x ${PER_WAVE} requests = ${served} scored`,
          `soak: forced collection ${collectedHeap().forced ? "available" : "UNAVAILABLE — readings are noisy"}`,
          `soak: ${staleOperations} stale database operations dropped (see storeGeneration)`,
          `soak: heap MB by wave  ${series.map((b) => (b / 1024 / 1024).toFixed(1)).join(" ")}`,
          `soak: spread ${((high - low) / 1024 / 1024).toFixed(1)} MB over ${requestsMeasured} measured requests` +
            ` = ${perRequest.toFixed(1)} bytes/request`,
          `soak: allowance ${(allowance / 1024 / 1024).toFixed(1)} MB` +
            ` (${(NOISE_BYTES / 1024 / 1024).toFixed(0)} MB noise + ${PER_REQUEST_BYTES} B/request)`,
          `soak: ${requestsMeasured * PER_REQUEST_BYTES > NOISE_BYTES ? "scaling term dominates — this is a measurement" : "NOISE TERM DOMINATES — widen the run before believing this"}`,
          "",
        ].join("\n"),
      );

      expect(high - low).toBeLessThan(allowance);
    },
    600_000,
  );

  it(
    "keeps the spend counter exact across a full-width simultaneous burst",
    async () => {
      /**
       * The same property the default tier checks at 200, at the soak's own
       * width — ten times that at the defaults, and so ten times the chance of
       * an interleaving the atomic update does not survive.
       *
       * Phrased differently from the 200-wide case, and the difference is the
       * finding rather than a convenience. At this width some responses are
       * lost on the way back (measured: 70 of 2,000; see burstReport), so the
       * client's count of successes is not the number of calls the server
       * made. Comparing a counter against it would be comparing a counter
       * against the network.
       *
       * What must hold exactly is that every server-side count of a scored
       * call agrees with every other one: the provider was called once per
       * charge, the histogram saw one observation per charge, and the shared
       * document holds one increment per charge. A lost increment breaks the
       * first equality; a double-charge breaks it the other way.
       */
      const outcomes = await burst(app.base, CONCURRENCY);
      const report = burstReport(outcomes);
      process.stdout.write(`\nsoak: scored burst — ${report.describe}\n\n`);

      const snap = app.metrics.snapshot();
      const scored = snap.counters["scoring.calls"];

      expect(scored).toBe(sdkCalls);
      expect(spendCounter()?.calls).toBe(scored);
      expect(snap.latency.provider.count).toBe(scored);
      expect(spendCounter()?.billableSeconds).toBe((scored ?? 0) * 2);

      // The client's successes are a floor under that, never above it — and
      // every answer the client did get was a score, not a refusal.
      expect(scored).toBeGreaterThanOrEqual(report.ok);
      expect(tally(report.answered)).toEqual({ "200/ok": report.ok });
      // Most of them did arrive. A width at which almost nothing completes
      // would make the equalities above true and meaningless.
      expect(report.ok).toBeGreaterThan(CONCURRENCY / 2);
    },
    600_000,
  );

  it(
    "refuses a full-width burst of oversize uploads without falling over",
    async () => {
      /**
       * The 480-request probe at the soak's own width — four times that at
       * the defaults. `memoryStorage` means every one of these is bytes an
       * unauthenticated caller has chosen to put in this process's heap, and
       * the only thing between that and an out-of-memory kill is the multer
       * ceiling.
       */
      const outcomes = await burst(app.base, CONCURRENCY, OVERSIZE_AUDIO);
      const report = burstReport(outcomes);
      process.stdout.write(`\nsoak: oversize burst — ${report.describe}\n\n`);

      // Nothing through, nothing spent — exact, at any width.
      expect(outcomes.filter((o) => o.status === 200)).toEqual([]);
      expect(sdkCalls).toBe(0);
      expect(spendCounter()).toBeUndefined();
      // Every refusal the server answered named the right reason. See the note
      // on burstReport: at this width most clients get a write error rather
      // than the answer, which is HTTP working as designed and not the guard
      // failing.
      expect(tally(report.answered)).toEqual({ "400/AUDIO_TOO_LONG": report.answered.length });
      expect(report.answered.length).toBeGreaterThan(0);
      // Still alive, still able to score.
      expect((await fetch(`${app.base}/healthz`)).status).toBe(200);
      expect(await scoreOnce(app.base, CONCURRENCY + 1)).toEqual({ status: 200, code: null });
    },
    600_000,
  );
});
