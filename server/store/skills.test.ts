/**
 * The skills repository.
 *
 * The concurrency guard is shared (mergeStore.ts) and exercised in detail by
 * progress.test.ts, so this covers what is specific to skills: that a second
 * device's sample history is *added* to rather than replacing, and that the
 * per-learner-per-language keying holds.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "../domain/merge.js";

interface Doc {
  _id: string;
  learnerId: string;
  slug: string;
  skills: Skill[];
  version: number;
  updatedAt: Date;
}

let store: Map<string, Doc>;

vi.mock("../db.js", () => ({
  getDb: () =>
    Promise.resolve({
      collection: () => ({
        findOne: (f: { _id: string }) => Promise.resolve(structuredClone(store.get(f._id) ?? null)),
        find: (f: { learnerId: string }) => ({
          toArray: () => Promise.resolve([...store.values()].filter((d) => d.learnerId === f.learnerId)),
        }),
        insertOne: (doc: Doc) => {
          if (store.has(doc._id)) {
            const err = new Error("dup") as Error & { code: number };
            err.code = 11000;
            return Promise.reject(err);
          }
          store.set(doc._id, structuredClone(doc));
          return Promise.resolve({ acknowledged: true });
        },
        updateOne: (f: { _id: string; version?: number }, u: Record<string, Record<string, unknown>>) => {
          const existing = store.get(f._id);
          if (existing === undefined || (f.version !== undefined && existing.version !== f.version)) {
            return Promise.resolve({ matchedCount: 0, acknowledged: true });
          }
          store.set(f._id, { ...existing, ...(u["$set"] as Partial<Doc>), version: existing.version + 1 });
          return Promise.resolve({ matchedCount: 1, acknowledged: true });
        },
        deleteMany: (f: { learnerId: string }) => {
          for (const [k, v] of store) if (v.learnerId === f.learnerId) store.delete(k);
          return Promise.resolve({ acknowledged: true });
        },
      }),
    }),
}));

vi.mock("../logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const LEARNER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER = "11111111-2222-4333-8444-555555555555";

function skill(grapheme: string, samples: Array<{ at: string; accuracy: number }>): Skill {
  return { grapheme, samples };
}

async function load() {
  vi.resetModules();
  return import("./skills.js");
}

beforeEach(() => {
  store = new Map();
  vi.clearAllMocks();
});

describe("accumulating a sound history", () => {
  it("stores a first push", async () => {
    const { mergeAndSaveSkills, readSkills } = await load();

    await mergeAndSaveSkills(LEARNER, {
      slug: "fr",
      skills: [skill("ment", [{ at: "2026-09-01T10:00:00.000Z", accuracy: 48 }])],
    });

    expect((await readSkills(LEARNER, "fr"))?.skills[0]?.samples).toHaveLength(1);
  });

  it("adds a second device's samples rather than replacing them", async () => {
    /**
     * The whole point. Under last-write-wins the learner would keep losing
     * half their evidence while every screen still showed a plausible trend,
     * computed from a fraction of the takes.
     */
    const { mergeAndSaveSkills } = await load();

    await mergeAndSaveSkills(LEARNER, {
      slug: "fr",
      skills: [skill("ment", [{ at: "2026-09-01T10:00:00.000Z", accuracy: 48 }])],
    });
    const result = await mergeAndSaveSkills(LEARNER, {
      slug: "fr",
      skills: [skill("ment", [{ at: "2026-09-05T10:00:00.000Z", accuracy: 61 }])],
    });

    expect(result.skills[0]?.samples.map((s) => s.accuracy)).toEqual([48, 61]);
  });

  it("returns the merged state, so a push is also a pull", async () => {
    const { mergeAndSaveSkills } = await load();
    await mergeAndSaveSkills(LEARNER, {
      slug: "fr",
      skills: [skill("jour", [{ at: "2026-09-01T10:00:00.000Z", accuracy: 70 }])],
    });

    const result = await mergeAndSaveSkills(LEARNER, {
      slug: "fr",
      skills: [skill("ment", [{ at: "2026-09-02T10:00:00.000Z", accuracy: 48 }])],
    });

    expect(result.skills.map((s) => s.grapheme)).toEqual(["jour", "ment"]);
  });

  it("does not double a take pushed twice", async () => {
    const { mergeAndSaveSkills } = await load();
    const push = {
      slug: "fr",
      skills: [skill("ment", [{ at: "2026-09-01T10:00:00.000Z", accuracy: 48 }])],
    };

    await mergeAndSaveSkills(LEARNER, push);
    const result = await mergeAndSaveSkills(LEARNER, push);

    expect(result.skills[0]?.samples).toHaveLength(1);
  });
});

describe("keying", () => {
  it("keeps each learner and language apart", async () => {
    const { mergeAndSaveSkills, readSkills, readAllSkills } = await load();

    await mergeAndSaveSkills(LEARNER, { slug: "fr", skills: [skill("ment", [{ at: "2026-09-01T10:00:00.000Z", accuracy: 48 }])] });
    await mergeAndSaveSkills(LEARNER, { slug: "es", skills: [skill("cion", [{ at: "2026-09-01T10:00:00.000Z", accuracy: 70 }])] });
    await mergeAndSaveSkills(OTHER, { slug: "fr", skills: [skill("ment", [{ at: "2026-09-01T10:00:00.000Z", accuracy: 90 }])] });

    expect((await readAllSkills(LEARNER)).map((s) => s.slug).sort()).toEqual(["es", "fr"]);
    expect((await readSkills(OTHER, "fr"))?.skills[0]?.samples[0]?.accuracy).toBe(90);
    expect(await readSkills(OTHER, "es")).toBeNull();
  });
});

describe("deleting", () => {
  it("removes one learner's languages and nobody else's", async () => {
    const { mergeAndSaveSkills, deleteSkills, readAllSkills } = await load();
    await mergeAndSaveSkills(LEARNER, { slug: "fr", skills: [skill("ment", [{ at: "2026-09-01T10:00:00.000Z", accuracy: 48 }])] });
    await mergeAndSaveSkills(OTHER, { slug: "fr", skills: [skill("ment", [{ at: "2026-09-01T10:00:00.000Z", accuracy: 48 }])] });

    await deleteSkills(LEARNER);

    expect(await readAllSkills(LEARNER)).toEqual([]);
    expect(await readAllSkills(OTHER)).toHaveLength(1);
  });
});
