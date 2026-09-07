/**
 * Content served from the database, and the two ways that goes badly.
 *
 * It can serve *less* than the bundle. A published set that validates to
 * nothing, or a set with no usable activities, would replace a working
 * language with an empty one — and an empty language reads to a learner as
 * "this is broken". So an unusable set is refused, and every caller falls back
 * to what the app shipped with.
 *
 * And it can change the words *under* a learner. Versions are part of the
 * document id and are never overwritten, so someone mid-session keeps the
 * phrases they started being scored against.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "mongodb";
import { latestVersion, publish, readContent, readLatest, type ContentDocument } from "./content.js";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let store: ContentDocument[];
let readFails = false;

vi.mock("../db.js", () => ({
  getDb: () => {
    if (readFails) return Promise.reject(new Error("no connection"));
    return Promise.resolve(fakeDb());
  },
}));

function fakeDb(): Db {
  return {
    collection: () => ({
      find: (filter: { slug: string }) => ({
        sort: () => ({
          limit: (n: number) => ({
            toArray: () =>
              Promise.resolve(
                store
                  .filter((d) => d.slug === filter.slug)
                  .sort((a, b) => b.version - a.version)
                  .slice(0, n),
              ),
          }),
        }),
      }),
      insertOne: (doc: ContentDocument) => {
        if (store.some((d) => d._id === doc._id)) {
          const err = new Error("E11000 duplicate key") as Error & { code: number };
          err.code = 11000;
          return Promise.reject(err);
        }
        store.push(doc);
        return Promise.resolve({ acknowledged: true });
      },
    }),
  } as unknown as Db;
}

function activity(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    title: "Greeting",
    kind: "repeat",
    prompt: "Say hello",
    gloss: "hello",
    target: "Bonjour",
    focus: "the French r",
    ...over,
  };
}

function set(over: Record<string, unknown> = {}) {
  return { slug: "fr", code: "fr-FR", label: "French", activities: [activity()], ...over };
}

beforeEach(() => {
  store = [];
  readFails = false;
  vi.clearAllMocks();
});

describe("refusing what it cannot serve", () => {
  it("accepts a well-formed set", () => {
    expect(readContent({ ...set(), version: 1 })?.activities).toHaveLength(1);
  });

  it("refuses a set with no usable activities", () => {
    /**
     * The one that would do damage. Serving an empty language replaces a
     * working bundled set with nothing, and an empty language reads to a
     * learner as a broken app rather than as missing content.
     */
    expect(readContent({ ...set(), version: 1, activities: [] })).toBeNull();
    expect(readContent({ ...set(), version: 1, activities: [null, 7, "x"] })).toBeNull();
  });

  it("refuses an activity with nothing to say aloud", () => {
    // A missing `target` means scoring speech against nothing.
    expect(readContent({ ...set(), version: 1, activities: [activity({ target: "" })] })).toBeNull();
  });

  it("refuses an activity with no instruction", () => {
    expect(readContent({ ...set(), version: 1, activities: [activity({ prompt: "" })] })).toBeNull();
  });

  it("keeps the good activities in a set with one bad one", () => {
    // A single typo should cost one activity, not a whole language.
    const content = readContent({
      ...set(),
      version: 1,
      activities: [activity({ id: 1 }), activity({ id: 2, target: "" }), activity({ id: 3 })],
    });

    expect(content?.activities.map((a) => a.id)).toEqual([1, 3]);
  });

  it.each([
    ["a bad slug", { slug: "FR" }],
    ["a path as a slug", { slug: "../etc" }],
    ["no code", { code: "" }],
    ["no label", { label: "" }],
    ["version zero", { version: 0 }],
    ["a fractional version", { version: 1.5 }],
    ["activities not an array", { activities: {} }],
  ])("refuses %s", (_label, over) => {
    expect(readContent({ ...set(), version: 1, ...over })).toBeNull();
  });
});

describe("reading the newest version", () => {
  it("returns the highest version, not the newest insert", async () => {
    // Publishing order and version order are different questions, and a
    // backfilled older version must not become current.
    store = [
      { ...set(), _id: "fr:2", version: 2, publishedAt: new Date("2026-01-01") } as ContentDocument,
      { ...set(), _id: "fr:1", version: 1, publishedAt: new Date("2026-09-01") } as ContentDocument,
    ];

    expect((await readLatest("fr"))?.version).toBe(2);
  });

  it("returns null for a language nobody has published", async () => {
    // The normal case, not an error: the client uses its bundled set.
    expect(await readLatest("de")).toBeNull();
  });

  it("returns null rather than throwing when the database is unreachable", async () => {
    readFails = true;

    await expect(readLatest("fr")).resolves.toBeNull();
  });

  it("refuses a published set that fails validation, loudly", async () => {
    /**
     * A published set that cannot be validated silently reverts every learner
     * to the bundled version, which looks like nothing happening. Worth an
     * error in the log rather than a shrug.
     */
    store = [{ ...set(), _id: "fr:1", version: 1, activities: [], publishedAt: new Date() } as ContentDocument];
    const { logger } = await import("../logger.js");

    expect(await readLatest("fr")).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "fr" }),
      expect.stringMatching(/failed validation/),
    );
  });
});

describe("publishing", () => {
  it("writes the set at the version given", async () => {
    const doc = await publish(fakeDb(), set(), 1);

    expect(doc._id).toBe("fr:1");
    expect(doc.publishedAt).toBeInstanceOf(Date);
  });

  it("never overwrites an existing version", async () => {
    /**
     * The id carries the version, so a second publish at the same number
     * collides rather than replacing. That is what stops a learner mid-session
     * being handed different words for the same activity.
     */
    const db = fakeDb();
    await publish(db, set(), 1);

    await expect(publish(db, set({ label: "Français" }), 1)).rejects.toThrow(/duplicate/i);
    expect(store).toHaveLength(1);
  });

  it("keeps both versions when a correction is published", async () => {
    const db = fakeDb();
    await publish(db, set(), 1);
    await publish(db, set({ activities: [activity({ target: "Bonsoir" })] }), 2);

    expect(store).toHaveLength(2);
    expect((await readLatest("fr"))?.activities[0]?.target).toBe("Bonsoir");
  });

  it("refuses to publish something it would refuse to serve", async () => {
    // Otherwise the failure surfaces later, as a language that silently
    // reverts to the bundle for reasons nobody can see.
    await expect(publish(fakeDb(), set({ activities: [] }), 1)).rejects.toThrow(/invalid/);
    expect(store).toHaveLength(0);
  });

  it("reports the highest published version", async () => {
    const db = fakeDb();
    expect(await latestVersion(db, "fr")).toBe(0);

    await publish(db, set(), 1);
    await publish(db, set(), 2);

    expect(await latestVersion(db, "fr")).toBe(2);
    // And is per language, so publishing French does not affect Spanish.
    expect(await latestVersion(db, "es")).toBe(0);
  });
});
