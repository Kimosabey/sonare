/**
 * The two things that could disagree about "what next", held to one answer.
 *
 * `GET /next` ranks sounds and picks an activity. `composeSession` composes a
 * sitting locally, offline included. Both answer "what should this learner do
 * now", they live in separate TypeScript programs that share no type, and
 * nothing in the build makes them agree — the same hazard `sync.contract.test.ts`
 * exists for, one layer up.
 *
 * The design is that the server is an **input** to the composer, never an
 * alternative to it. That distinction survives only while two things hold, and
 * this file holds the first while `composeSession.contract.test.ts` holds the
 * second:
 *
 *  1. **The reply is accepted as a refinement, as sent.** No adapter, no field
 *     rename, no restated literal. The `refinement` this route puts on the
 *     wire is passed directly as `composeSession`'s `SessionRefinement`, so a
 *     field renamed on either side stops compiling here.
 *  2. **Membership is unchanged.** Composing with the real reply and without it
 *     differs only in ordering — asserted there against every refinement the
 *     server can express, and asserted here against the one it actually sent.
 *
 * Real Express on an ephemeral port, the real route, the real scheduler. The
 * database is the only substitution, because what is under test is the answer
 * the route computes rather than how it stores anything.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { composeSession, type SessionRefinement } from "../../src/learning/composeSession.js";
import type { Activity, ActivityProgress, LanguageActivitySet } from "../../src/activities/types.js";
import type { Skill, SkillStore } from "../../src/stores/skillStore.js";

/* ── the one substitution ───────────────────────────────────────────────── */

interface Doc {
  _id: string;
  slug?: string;
  version?: number;
  [key: string]: unknown;
}

let store: Map<string, Doc>;
let progressThrows = false;

vi.mock("../db.js", () => ({
  getDb: () =>
    Promise.resolve({
      collection: (name: string) => ({
        findOne: (f: { _id: string }) => {
          if (name === "progress" && progressThrows) return Promise.reject(new Error("unreadable"));
          return Promise.resolve(structuredClone(store.get(`${name}/${f._id}`) ?? null));
        },
        find: (f: { slug?: string }) => ({
          sort: () => ({
            limit: () => ({
              toArray: () =>
                Promise.resolve(
                  [...store.entries()]
                    .filter(([key, doc]) => key.startsWith(`${name}/`) && doc.slug === f.slug)
                    .map(([, doc]) => structuredClone(doc))
                    .sort((a, b) => (b.version ?? 0) - (a.version ?? 0)),
                ),
            }),
          }),
        }),
        createIndex: () => Promise.resolve("ok"),
      }),
    }),
}));

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../rateLimit.js", () => ({
  diagnosticsLimiter: (_q: unknown, _s: unknown, next: () => void) => next(),
  scoringLimiter: (_q: unknown, _s: unknown, next: () => void) => next(),
  perLearnerScoringLimiter: (_q: unknown, _s: unknown, next: () => void) => next(),
}));

/* ── the app, and the credential ────────────────────────────────────────── */

const SECRET = "next-contract-suite-secret-not-a-real-one";
const LEARNER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SLUG = "fr";

/**
 * Fixed, and deliberately far from any wall clock. Every sample below is old
 * enough that its sound is due on any day this suite could run, so a case
 * cannot pass in the morning and fail at midnight.
 */
const TODAY = new Date("2026-09-13T09:00:00.000Z");
const LONG_AGO = "2026-01-01T09:00:00.000Z";

let server: Server;
let base: string;
let token: string;

beforeAll(async () => {
  // Before the import: identity.ts reads the secret at module load, so setting
  // it in a nested hook would configure a different instance than the one
  // listening and every request would 503 for the wrong reason.
  process.env.LEARNER_TOKEN_SECRET = SECRET;
  vi.resetModules();

  const express = (await import("express")).default;
  const { nextRouter } = await import("./next.js");
  const { issueToken } = await import("../identity.js");

  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use("/api/v1", nextRouter);

  await new Promise<void>((ready) => {
    server = app.listen(0, () => ready());
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  token = issueToken(LEARNER);
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  delete process.env.LEARNER_TOKEN_SECRET;
});

beforeEach(() => {
  store = new Map();
  progressThrows = false;
});

/* ── what both sides are given ──────────────────────────────────────────── */

/**
 * One activity, in both shapes.
 *
 * Built once and projected, rather than written twice. Two literals would let
 * the client's set and the published set drift apart, and then this file would
 * be testing a disagreement it invented rather than the one the route could
 * have.
 */
interface Seed {
  id: number;
  sounds: string[];
}

const SEEDS: Seed[] = [
  { id: 1, sounds: ["bon"] },
  { id: 2, sounds: ["jour"] },
  { id: 3, sounds: ["bon", "jour"] },
  { id: 4, sounds: ["soir"] },
];

function clientSet(seeds: Seed[] = SEEDS): LanguageActivitySet {
  return {
    code: "fr-FR",
    slug: SLUG,
    label: "French",
    activities: seeds.map(
      (seed): Activity => ({
        id: seed.id,
        title: `Activity ${String(seed.id)}`,
        kind: "repeat",
        prompt: `Say phrase ${String(seed.id)}`,
        gloss: `Phrase ${String(seed.id)}`,
        target: `Phrase ${String(seed.id)}`,
        focus: `focus ${String(seed.id)}`,
        soundTargets: seed.sounds,
      }),
    ),
  };
}

/** The same activities, as the server holds them. */
function publish(seeds: Seed[] = SEEDS, units?: unknown): void {
  store.set(`content/${SLUG}:1`, {
    _id: `${SLUG}:1`,
    slug: SLUG,
    code: "fr-FR",
    label: "French",
    version: 1,
    activities: seeds.map((seed) => ({
      id: seed.id,
      title: `Activity ${String(seed.id)}`,
      kind: "repeat",
      prompt: `Say phrase ${String(seed.id)}`,
      gloss: `Phrase ${String(seed.id)}`,
      target: `Phrase ${String(seed.id)}`,
      focus: `focus ${String(seed.id)}`,
      soundTargets: seed.sounds,
    })),
    ...(units === undefined ? {} : { units }),
    publishedAt: new Date(),
  });
}

/**
 * Sound history, in both shapes, from one description.
 *
 * Two samples each, because one is not a pattern and the scheduler excludes a
 * sound below that threshold — a single sample here would make every case
 * assert on an empty due list without saying so.
 */
function seedSkills(accuracies: Record<string, number>): SkillStore {
  const skills = Object.entries(accuracies).map(
    ([grapheme, accuracy]): Skill => ({
      grapheme,
      samples: [
        { at: LONG_AGO, accuracy },
        { at: LONG_AGO.replace("01T", "02T"), accuracy },
      ],
    }),
  );

  store.set(`skills/${LEARNER}:${SLUG}`, {
    _id: `${LEARNER}:${SLUG}`,
    learnerId: LEARNER,
    slug: SLUG,
    skills,
    version: 1,
  });

  return Object.fromEntries(skills.map((skill) => [skill.grapheme, skill]));
}

function seedProgress(entries: Array<{ activityId: number; passed: boolean; at: string }>): void {
  store.set(`progress/${LEARNER}:${SLUG}`, {
    _id: `${LEARNER}:${SLUG}`,
    learnerId: LEARNER,
    slug: SLUG,
    entries: entries.map((e) => ({ ...e, bestAccuracy: null, attemptsUsed: 1, skipped: false })),
    version: 1,
  });
}

/* ── the round trip ─────────────────────────────────────────────────────── */

interface Reply {
  slug: string;
  due: Array<{ grapheme: string; strength: number }>;
  all: Array<{ grapheme: string }>;
  activitySelected: boolean;
  refinement?: SessionRefinement;
}

async function ask(): Promise<{ status: number; body: Reply }> {
  const res = await fetch(`${base}/api/v1/next?slug=${SLUG}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: (await res.json()) as Reply };
}

const NO_PROGRESS: ActivityProgress[] = [];

describe("the reply is a refinement, as sent", () => {
  /**
   * The assertion the file exists for. The route's own object goes into the
   * composer with nothing done to it on the way — so a field renamed on either
   * side stops compiling, and a field added to one and forgotten on the other
   * shows up as a key-set difference below rather than as a silently ignored
   * preference.
   */
  it("is passed to composeSession without an adapter", async () => {
    const skills = seedSkills({ bon: 30, jour: 40 });
    publish();
    seedProgress([{ activityId: 1, passed: true, at: LONG_AGO }]);

    const { status, body } = await ask();
    expect(status).toBe(200);
    expect(body.activitySelected).toBe(true);
    const refinement = body.refinement;
    expect(refinement).toBeDefined();
    if (refinement === undefined) return;

    // No literal, no mapping — the wire object itself.
    const refined = composeSession(clientSet(), NO_PROGRESS, skills, TODAY, refinement);

    expect(refined.opening?.from).toBe("server");
    expect(refined.opening?.activityId).toBe(refinement.activityId);
  });

  /**
   * Key-set agreement, the drift this catches. Add a field to `Selection` and
   * forget it on `SessionRefinement` — or the reverse — and this goes red
   * while both sides stay individually self-consistent.
   */
  it("sends exactly the keys a refinement has, no more and no fewer", async () => {
    seedSkills({ bon: 30 });
    publish();

    const { body } = await ask();
    expect(body.refinement).toBeDefined();
    if (body.refinement === undefined) return;

    // Built from the client's type, so it cannot drift from what the composer
    // reads; `satisfies` keeps the literal honest rather than widening it.
    const shape = {
      activityId: 1,
      reason: "due-sounds",
      covers: [],
    } satisfies SessionRefinement;

    expect(Object.keys(body.refinement).sort()).toEqual(Object.keys(shape).sort());
  });

  it("names a reason the composer's type admits", async () => {
    seedSkills({ bon: 30 });
    publish();

    const { body } = await ask();
    const reasons: Array<SessionRefinement["reason"]> = [
      "due-sounds",
      "unpractised",
      "weakest-unpassed",
    ];
    expect(reasons).toContain(body.refinement?.reason);
  });
});

describe("what the server adds, and what it may not change", () => {
  /**
   * The design claim, against the reply the route actually sent rather than
   * against every refinement it could have. `composeSession.contract.test.ts`
   * does the exhaustive half; this one proves the real answer is inside it.
   */
  it("changes the order of the sitting and not its membership", async () => {
    const skills = seedSkills({ bon: 30, jour: 40, soir: 90 });
    publish();

    const { body } = await ask();
    expect(body.refinement).toBeDefined();
    if (body.refinement === undefined) return;

    const content = clientSet();
    const local = composeSession(content, NO_PROGRESS, skills, TODAY);
    const refined = composeSession(content, NO_PROGRESS, skills, TODAY, body.refinement);

    const ids = (s: typeof local): number[] => s.activities.map((a) => a.id).sort((x, y) => x - y);
    expect(ids(refined)).toEqual(ids(local));
    expect(refined.reviews).toEqual(local.reviews);
    expect(refined.lesson).toEqual(local.lesson);
  });

  /**
   * The whole reason for selecting over syllables rather than over activities.
   * Activity 3 drills both due sounds; 1 and 2 drill one each.
   */
  it("picks the activity covering the most due sounds", async () => {
    seedSkills({ bon: 30, jour: 35 });
    publish();

    const { body } = await ask();
    expect(body.refinement?.activityId).toBe(3);
    expect(body.refinement?.reason).toBe("due-sounds");
    // Weakest first, so a screen listing them leads with the worst.
    expect(body.refinement?.covers).toEqual(["bon", "jour"]);
  });

  /**
   * `MAX_DUE` truncates what is shown, not what is selected over. Six due
   * sounds, an activity drilling the sixth: selecting over the shown list
   * would never see it.
   */
  it("selects over every due sound, not only the ones it shows", async () => {
    const many: Record<string, number> = {};
    // Descending accuracy, so `sixth` sorts last and falls outside MAX_DUE = 5.
    const graphemes = ["aa", "bb", "cc", "dd", "ee", "sixth"];
    graphemes.forEach((g, i) => (many[g] = 20 + i * 5));
    seedSkills(many);
    publish([{ id: 9, sounds: ["sixth"] }]);

    const { body } = await ask();

    expect(body.due).toHaveLength(5);
    expect(body.due.map((d) => d.grapheme)).not.toContain("sixth");
    // Chosen anyway, from a sound the response did not list.
    expect(body.refinement).toEqual({ activityId: 9, reason: "due-sounds", covers: ["sixth"] });
  });
});

describe("what it refuses to guess", () => {
  /**
   * The client is on its bundled set, which this process does not import, so
   * there is no grapheme mapping to select over. The sounds still go back —
   * they are the half the client could not compute for itself.
   */
  it("chooses nothing when no set is published, and still returns the sounds", async () => {
    seedSkills({ bon: 30 });

    const { status, body } = await ask();

    expect(status).toBe(200);
    expect(body.activitySelected).toBe(false);
    expect(body.refinement).toBeUndefined();
    expect(body.due.map((d) => d.grapheme)).toEqual(["bon"]);
  });

  /**
   * The distinction that stops a recommendation being a lie: a learner with no
   * progress document genuinely has nothing attempted, and `unpractised` is
   * true of them. An *unreadable* document is not the same thing, and calling
   * it one would offer a learner who has done thirty activities the first one,
   * wearing the word "recommended".
   */
  it("chooses nothing when progress is unreadable, rather than calling it unpractised", async () => {
    seedSkills({ bon: 30 });
    publish();
    progressThrows = true;

    const { status, body } = await ask();

    expect(status).toBe(200);
    expect(body.activitySelected).toBe(false);
    expect(body.due.map((d) => d.grapheme)).toEqual(["bon"]);
  });

  it("does choose for a learner who has genuinely attempted nothing", async () => {
    seedSkills({ bon: 30 });
    publish();

    const { body } = await ask();

    expect(body.activitySelected).toBe(true);
    expect(body.refinement?.activityId).toBe(1);
  });

  /**
   * A spine's lessons are the course. Activity 4 is in the flat list and in no
   * lesson, so offering it would hand a learner following a journey something
   * outside it — and the publish gate never required it to carry sound
   * targets, so it could only ever arrive as a fallback anyway.
   */
  it("never reaches past the spine into an activity no lesson leads to", async () => {
    // Nothing due, so only the fallbacks are left — and activity 4 is the one
    // they would reach for, being unattempted and last.
    seedSkills({ bon: 95 });
    publish(SEEDS, [
      {
        id: 1,
        title: "Greetings",
        outcome: "I can greet someone",
        lessons: [{ id: 1, title: "Hello", outcome: "I can say hello", activityIds: [1, 2, 3] }],
      },
    ]);
    seedProgress([
      { activityId: 1, passed: true, at: "2026-02-01T09:00:00.000Z" },
      { activityId: 2, passed: true, at: "2026-02-02T09:00:00.000Z" },
      { activityId: 3, passed: true, at: "2026-02-03T09:00:00.000Z" },
    ]);

    const { body } = await ask();

    expect(body.refinement?.activityId).not.toBe(4);
    expect([1, 2, 3]).toContain(body.refinement?.activityId);
  });

  /**
   * An unreadable schedule is the one failure that is still a 503, because the
   * sounds are what the client came for. Kept here so that adding a second
   * read to this route cannot quietly turn a degraded pick into a failed
   * request.
   */
  it("still answers when there is no history at all", async () => {
    publish();

    const { status, body } = await ask();

    expect(status).toBe(200);
    expect(body.due).toEqual([]);
    expect(body.all).toEqual([]);
    // Nothing is due, but there is plenty to do.
    expect(body.refinement?.reason).toBe("unpractised");
  });
});
