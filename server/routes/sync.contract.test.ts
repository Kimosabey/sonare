/**
 * The client's codec against the server's real snapshot.
 *
 * `src/sync/wire.ts` and this route are two hand-written codecs for one wire
 * format, on opposite sides of a network, in separate TypeScript programs that
 * share no type. Nothing in the build makes them agree. A field added to one
 * and forgotten on the other compiles, lints, passes both unit suites, and
 * silently drops part of a learner's progress on every sync from then on —
 * with no error anywhere, because both sides are individually self-consistent.
 *
 * So this file drives the **real route** over real HTTP, encodes the request
 * with the client's own `*ToWire` functions, and decodes the reply with the
 * client's own `readSnapshot`/`*FromWire`. Nothing about the shape is restated
 * here as a literal — a hand-written expected object would just be a third
 * codec to keep in step.
 *
 * Two kinds of assertion, and the first is the point:
 *
 *  - **Key-set agreement.** The keys the server sends and the keys the client
 *    builds are compared as sets, at every level: the snapshot, a progress
 *    entry, a skill, a sample, the streak. Add `attemptsUsed` to one side only
 *    and this goes red, which is the drift the file exists to catch.
 *  - **Value round-trip.** Every field that carries meaning survives the loop
 *    intact: progress entries, skills, streak days and longest.
 *
 * And the documented asymmetry, from wire.ts:10-14 — the local record holds
 * every attempt's full provider result, the server holds none of them, and so
 * folding a reply back must *keep* the local attempts. Asserted here through
 * the real route rather than against a fixture, because the reply that has to
 * be survivable is the one the server actually sends.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  progressFromWire,
  progressToWire,
  readSnapshot,
  skillsFromWire,
  skillsToWire,
  streakToWire,
  type SyncSnapshot,
  type WireProgress,
  type WireSkills,
} from "../../src/sync/wire.js";
import type { ActivityAttempt, ActivityProgress } from "../../src/activities/types.js";
import type { PersistedProgress } from "../../src/hooks/useProgressPersistence.js";
import type { SkillStore } from "../../src/stores/skillStore.js";
import type { Streak } from "../../src/stores/streakStore.js";

/* ── the one substitution ───────────────────────────────────────────────── */

interface Doc {
  _id: string;
  learnerId?: string;
  version?: number;
  [key: string]: unknown;
}

let store: Map<string, Doc>;

vi.mock("../db.js", () => ({
  getDb: () =>
    Promise.resolve({
      collection: (name: string) => ({
        findOne: (f: { _id: string }) => Promise.resolve(structuredClone(store.get(`${name}/${f._id}`) ?? null)),
        find: (f: { learnerId?: string }) => ({
          toArray: () =>
            Promise.resolve(
              [...store.entries()]
                .filter(([key, doc]) => key.startsWith(`${name}/`) && doc.learnerId === f.learnerId)
                .map(([, doc]) => structuredClone(doc)),
            ),
        }),
        insertOne: (doc: Doc) => {
          const key = `${name}/${doc._id}`;
          if (store.has(key)) {
            const err = new Error("duplicate key") as Error & { code: number };
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
          store.set(key, { ...existing, ...(u["$set"] ?? {}), version: (existing.version ?? 0) + 1 } as Doc);
          return Promise.resolve({ matchedCount: 1, acknowledged: true });
        },
        deleteMany: () => Promise.resolve({ acknowledged: true, deletedCount: 0 }),
        createIndex: () => Promise.resolve("ok"),
      }),
    }),
}));

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../rateLimit.js", () => ({
  // The limiters are not what this file is about, and a shared fixed window
  // would make a contract test's pass depend on how many other cases ran.
  diagnosticsLimiter: (_q: unknown, _s: unknown, next: () => void) => next(),
  scoringLimiter: (_q: unknown, _s: unknown, next: () => void) => next(),
  perLearnerScoringLimiter: (_q: unknown, _s: unknown, next: () => void) => next(),
}));

/* ── the app, and the credential ────────────────────────────────────────── */

const SECRET = "contract-suite-secret-not-a-real-one";
const LEARNER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SECOND = "11111111-2222-4333-8444-555555555555";
const SLUG = "fr";

let server: Server;
let base: string;
let token: string;
let secondToken: string;

beforeAll(async () => {
  // Set before the import, because identity.ts reads it at module load — the
  // nested-beforeAll mistake would configure a different instance than the
  // running app and every request would 503 for the wrong reason.
  process.env.LEARNER_TOKEN_SECRET = SECRET;
  vi.resetModules();

  const express = (await import("express")).default;
  const { syncRouter } = await import("./sync.js");
  const { issueToken } = await import("../identity.js");

  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use("/api/v1", syncRouter);

  await new Promise<void>((ready) => {
    server = app.listen(0, () => ready());
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  token = issueToken(LEARNER);
  secondToken = issueToken(SECOND);
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  delete process.env.LEARNER_TOKEN_SECRET;
});

/** A fresh store per case, so no round trip inherits another's merge. */
beforeEach(() => {
  store = new Map();
});

/* ── the client side, built with the client's own types ─────────────────── */

function attempt(at: string, accuracy: number): ActivityAttempt {
  // `result` is the full provider payload, which is exactly the thing the
  // server has no copy of. Its content does not matter; its survival does.
  return { activityId: 1, result: { marker: at } as never, accuracy, at };
}

function activity(over: Partial<ActivityProgress> = {}): ActivityProgress {
  return {
    activityId: 1,
    attempts: [attempt("2026-09-07T10:00:00.000Z", 71)],
    best: 71,
    passed: false,
    skipped: false,
    ...over,
  };
}

/** A local record with something in every field that crosses the wire. */
function localProgress(): PersistedProgress {
  return {
    index: 3,
    finished: false,
    progress: [
      activity({
        activityId: 1,
        attempts: [attempt("2026-09-07T10:00:00.000Z", 71), attempt("2026-09-07T10:05:00.000Z", 88)],
        best: 88,
        passed: true,
      }),
      activity({ activityId: 2, attempts: [attempt("2026-09-07T11:00:00.000Z", 40)], best: 40, skipped: true }),
      activity({ activityId: 3, attempts: [], best: null, passed: false, skipped: false }),
    ],
  };
}

function localSkills(): SkillStore {
  return {
    ment: {
      grapheme: "ment",
      samples: [
        { at: "2026-09-06T09:00:00.000Z", accuracy: 55 },
        { at: "2026-09-07T09:00:00.000Z", accuracy: 72 },
      ],
    },
    eux: { grapheme: "eux", samples: [{ at: "2026-09-07T09:30:00.000Z", accuracy: 61 }] },
  };
}

function localStreak(): Streak {
  return { days: ["2026-09-05", "2026-09-06", "2026-09-07"], current: 3, longest: 9 };
}

/* ── the round trip, over the real route ────────────────────────────────── */

function headers(as = token): Record<string, string> {
  return { "content-type": "application/json", authorization: `Bearer ${as}` };
}

/** POSTs a body the client built, and returns the raw reply as the client sees it. */
async function push(body: unknown, as = token): Promise<unknown> {
  const res = await fetch(`${base}/api/v1/sync`, { method: "POST", headers: headers(as), body: JSON.stringify(body) });
  expect(res.status).toBe(200);
  return res.json();
}

async function pull(as = token): Promise<unknown> {
  const res = await fetch(`${base}/api/v1/sync`, { headers: headers(as) });
  expect(res.status).toBe(200);
  return res.json();
}

/** Exactly the body engine.ts builds for a fully dirty client. */
function requestBody(
  progress: PersistedProgress = localProgress(),
  skills: SkillStore = localSkills(),
  streak: Streak = localStreak(),
): { progress: WireProgress[]; skills: WireSkills[]; streak: { days: string[]; longest: number } } {
  return {
    progress: [progressToWire(SLUG, progress)],
    skills: [skillsToWire(SLUG, skills)],
    streak: streakToWire(streak),
  };
}

/** The reply, decoded by the client's own reader. Fails loudly if it is refused. */
function decode(raw: unknown): SyncSnapshot {
  const snapshot = readSnapshot(raw);
  // Null means the client would have discarded the whole reply as
  // "shaped like JSON but not like a snapshot" and synced nothing, silently.
  expect(snapshot).not.toBeNull();
  return snapshot as SyncSnapshot;
}

function keysOf(value: unknown): string[] {
  return Object.keys(value as Record<string, unknown>).sort();
}

/* ── 1. the two codecs agree about what the fields are ──────────────────── */

describe("the shapes on either side of the wire", () => {
  it("sends a reply the client's reader accepts", async () => {
    const raw = await push(requestBody());

    // The whole contract in one line: if `readSnapshot` refuses this, every
    // sync is a no-op and the learner's second device stays empty forever.
    expect(readSnapshot(raw)).not.toBeNull();
  });

  it("sends a reply to a pull the client's reader accepts too", async () => {
    await push(requestBody());

    expect(readSnapshot(await pull())).not.toBeNull();
  });

  it("carries exactly the three domains the client reads, and no fourth", async () => {
    const raw = await push(requestBody());

    // A domain added server-side and not read by the client would show up
    // here — as would one the client expects and the server stopped sending.
    expect(keysOf(raw)).toEqual(keysOf(decode(raw)));
    expect(keysOf(raw)).toEqual(["progress", "skills", "streak"]);
  });

  it("agrees field for field about a progress entry", async () => {
    const sent = requestBody();
    const raw = await push(sent);

    const theirs = decode(raw).progress[0]?.entries[0];
    const mine = sent.progress[0]?.entries[0];

    // Set comparison, not a literal list: the expectation is *the client's own
    // encoder*, so adding a field to one side alone is what fails.
    expect(keysOf(theirs)).toEqual(keysOf(mine));
    expect(keysOf(mine)).toEqual(["activityId", "at", "attemptsUsed", "bestAccuracy", "passed", "skipped"]);
  });

  it("agrees field for field about a language's progress", async () => {
    const sent = requestBody();
    const raw = await push(sent);

    expect(keysOf(decode(raw).progress[0])).toEqual(keysOf(sent.progress[0]));
  });

  it("agrees field for field about a skill and its samples", async () => {
    const sent = requestBody();
    const raw = await push(sent);

    const theirs = decode(raw).skills[0];
    const mine = sent.skills[0];

    expect(keysOf(theirs)).toEqual(keysOf(mine));
    expect(keysOf(theirs?.skills[0])).toEqual(keysOf(mine?.skills[0]));
    expect(keysOf(theirs?.skills[0]?.samples[0])).toEqual(keysOf(mine?.skills[0]?.samples[0]));
  });

  it("agrees field for field about the streak", async () => {
    const sent = requestBody();
    const raw = await push(sent);

    expect(keysOf(decode(raw).streak)).toEqual(keysOf(sent.streak));
  });

  it("keeps the current run off the wire, because only the client knows the timezone", async () => {
    const sent = requestBody();
    const raw = await push(sent);

    /**
     * The deliberate omission, from merge.ts's streak comment: a request at
     * 23:40 in Auckland and one at 23:40 in Lisbon look identical to the
     * server, so a `current` computed there is wrong for most of the world for
     * part of every day. The client derives it against its own clock.
     */
    expect(sent.streak).not.toHaveProperty("current");
    expect(decode(raw).streak).not.toHaveProperty("current");
    expect(localStreak().current).toBe(3);
  });
});

/* ── 2. the values survive the loop ─────────────────────────────────────── */

describe("what the learner accumulated survives the round trip", () => {
  it("returns every progress entry it was sent, field for field", async () => {
    const sent = requestBody();
    const raw = await push(sent);

    expect(decode(raw).progress[0]?.entries).toEqual(sent.progress[0]?.entries);
  });

  it("returns every skill and every sample it was sent", async () => {
    const sent = requestBody();
    const raw = await push(sent);

    const theirs = decode(raw).skills[0]?.skills ?? [];
    const mine = sent.skills[0]?.skills ?? [];

    // Sorted by grapheme server-side, so compare as sets of graphemes and
    // then per grapheme rather than by position.
    expect(new Set(theirs.map((s) => s.grapheme))).toEqual(new Set(mine.map((s) => s.grapheme)));
    for (const skill of mine) {
      expect(theirs.find((s) => s.grapheme === skill.grapheme)?.samples).toEqual(skill.samples);
    }
  });

  it("returns the practice days it was sent", async () => {
    const sent = requestBody();
    const raw = await push(sent);

    expect(decode(raw).streak.days).toEqual(sent.streak.days);
  });

  it("returns the record run, which a lapse must never erase", async () => {
    // `longest` is the one streak field a client can lose outright: it is not
    // derivable from a capped day list, so a codec that dropped it would take
    // a learner's best run with it.
    const sent = requestBody();
    const raw = await push(sent);

    expect(decode(raw).streak.longest).toBe(9);
    expect(sent.streak.longest).toBe(9);
  });

  it("keeps a best score exactly as the provider reported it", async () => {
    // R3: stored, never recomputed. A rounding or a rescale anywhere in the
    // loop would change what the learner is told they scored.
    const raw = await push(requestBody());

    expect(decode(raw).progress[0]?.entries.find((e) => e.activityId === 1)?.bestAccuracy).toBe(88);
  });

  it("carries the attempt count without carrying the attempts", async () => {
    const sent = requestBody();
    const raw = await push(sent);
    const entry = decode(raw).progress[0]?.entries.find((e) => e.activityId === 1);

    expect(entry?.attemptsUsed).toBe(2);
    // The summary is the point of the asymmetry: two attempts, and none of
    // the provider payloads that produced them.
    expect(JSON.stringify(raw)).not.toContain("marker");
  });

  it("drops an activity the learner never touched, rather than sending it as a zero", async () => {
    const sent = requestBody();
    const raw = await push(sent);

    // Activity 3 has no attempts, no pass and no skip. An entry saying "not
    // passed, no attempts" is indistinguishable from no entry, and sending
    // them would push four languages of untouched activities on a first sync.
    expect(sent.progress[0]?.entries.map((e) => e.activityId)).toEqual([1, 2]);
    expect(decode(raw).progress[0]?.entries.map((e) => e.activityId)).toEqual([1, 2]);
  });

  it("gives identical facts an identical response, so a change is cheap to detect", async () => {
    const raw = await push(requestBody());
    const again = await push(requestBody());

    // Both sides sort, so the same state has one representation. Without that
    // a "did anything change" check can never be a comparison.
    expect(JSON.stringify(again)).toBe(JSON.stringify(raw));
  });
});

/* ── 3. the asymmetry: folding back must not destroy local attempts ─────── */

describe("folding a reply back into the local record", () => {
  it("never replaces the local attempts, because the server has no copy", async () => {
    /**
     * The failure this file was written for. Nothing on any screen would look
     * broken — the scores, the passes and the streak would all be right — and
     * the playback of the learner's own audio would simply be gone from the
     * device that recorded it.
     */
    const local = localProgress();
    const raw = await push(requestBody(local));
    const incoming = decode(raw).progress[0] as WireProgress;

    const folded = progressFromWire(local, incoming);

    const one = folded.progress.find((p) => p.activityId === 1);
    expect(one?.attempts).toHaveLength(2);
    expect(one?.attempts.map((a) => a.at)).toEqual(["2026-09-07T10:00:00.000Z", "2026-09-07T10:05:00.000Z"]);
    // The full provider result, still there.
    expect(one?.attempts[0]?.result).toEqual({ marker: "2026-09-07T10:00:00.000Z" });
  });

  it("keeps the attempts even when the server's reply is the union of two devices", async () => {
    // The realistic case: this device pushes, another device has already
    // pushed more, and the reply is bigger than what was sent.
    const other = requestBody({
      index: 0,
      finished: false,
      progress: [activity({ activityId: 4, attempts: [attempt("2026-09-08T10:00:00.000Z", 95)], best: 95, passed: true })],
    });
    await push(other);

    const local = localProgress();
    const raw = await push(requestBody(local));
    const folded = progressFromWire(local, decode(raw).progress[0] as WireProgress);

    expect(folded.progress.find((p) => p.activityId === 1)?.attempts).toHaveLength(2);
    // The other device's activity arrives with an honestly empty attempt list
    // rather than a fabricated one.
    expect(folded.progress.find((p) => p.activityId === 4)?.attempts).toEqual([]);
    expect(folded.progress.find((p) => p.activityId === 4)?.passed).toBe(true);
  });

  it("does not let a stale reply un-pass an activity", async () => {
    // The server merges `passed` with OR and so does the client, which is
    // what makes the order of two devices' pushes irrelevant.
    const raw = await push(requestBody());
    const stale: WireProgress = {
      slug: SLUG,
      entries: [{ activityId: 1, passed: false, bestAccuracy: 10, attemptsUsed: 1, skipped: true, at: "2020-01-01T00:00:00.000Z" }],
    };
    void raw;

    const folded = progressFromWire(localProgress(), stale);
    const one = folded.progress.find((p) => p.activityId === 1);

    expect(one?.passed).toBe(true);
    expect(one?.best).toBe(88);
    expect(one?.attempts).toHaveLength(2);
  });

  it("does not sync where this device left off", async () => {
    const local = localProgress();
    const raw = await push(requestBody(local));

    const folded = progressFromWire(local, decode(raw).progress[0] as WireProgress);

    // A second device's position is not this one's, so `index` is local-only.
    expect(folded.index).toBe(3);
  });

  it("overwrites the local skills, because the server's samples are a superset", async () => {
    // Unlike progress: the server's history already includes this device's
    // samples, so folding is a replace rather than a merge — and the round
    // trip has to prove nothing is lost by that.
    const skills = localSkills();
    const raw = await push(requestBody(localProgress(), skills));

    const folded = skillsFromWire(decode(raw).skills[0] as WireSkills);

    expect(Object.keys(folded).sort()).toEqual(["eux", "ment"]);
    expect(folded["ment"]?.samples).toEqual(skills["ment"]?.samples);
  });

  it("comes back byte-identical after a second loop", async () => {
    // Idempotence across the real route: encode, push, decode, fold, encode
    // again, and the second request is the first.
    const local = localProgress();
    const first = requestBody(local);
    const raw = await push(first);
    const folded = progressFromWire(local, decode(raw).progress[0] as WireProgress);

    expect(progressToWire(SLUG, folded)).toEqual(first.progress[0]);
  });
});

/* ── 4. the contract holds per learner ──────────────────────────────────── */

describe("the contract is per learner", () => {
  it("does not fold one learner's record into another's", async () => {
    await push(requestBody());

    const theirs = decode(await pull(secondToken));

    expect(theirs).toEqual({ progress: [], skills: [], streak: { days: [], longest: 0 } });
  });

  it("gives a first-time device an empty snapshot its reader still accepts", async () => {
    /**
     * The shape that has to survive is the empty one too: a fresh install
     * pulls before it has anything, and `readSnapshot` returning null here
     * would make the first sync of every new device a silent no-op.
     */
    const raw = await pull(secondToken);
    const snapshot = decode(raw);

    expect(snapshot.progress).toEqual([]);
    expect(snapshot.skills).toEqual([]);
    expect(snapshot.streak).toEqual({ days: [], longest: 0 });
    // Folding an empty reply must still leave the local record alone.
    expect(progressFromWire(localProgress(), { slug: SLUG, entries: [] })).toEqual(localProgress());
  });
});
