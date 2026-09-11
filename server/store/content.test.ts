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
import {
  contentProblems,
  latestVersion,
  listVersions,
  publish,
  readContent,
  readDraft,
  readLatest,
  readVersion,
  type ContentDocument,
} from "./content.js";

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
      findOne: (filter: { _id: string }) =>
        Promise.resolve(store.find((d) => d._id === filter._id) ?? null),
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

/**
 * Three activities whose targets each contain the syllable they name, because
 * a sound target that does not occur in its phrase is refused — see the rule
 * it is testing.
 */
function courseActivities() {
  return [
    activity({ id: 1, target: "Bonjour", soundTargets: ["bon", "jour"] }),
    activity({ id: 2, target: "Bonsoir", soundTargets: ["soir"] }),
    activity({ id: 3, target: "Merci", soundTargets: ["mer"] }),
  ];
}

/** The smallest set with a spine: one unit, one lesson, three activities. */
function course(over: Record<string, unknown> = {}) {
  return set({
    activities: courseActivities(),
    units: [
      {
        id: 1,
        title: "Meeting people",
        outcome: "You can greet someone and be understood.",
        lessons: [
          {
            id: 1,
            title: "Hello and goodbye",
            outcome: "You can say hello and goodbye.",
            activityIds: [1, 2, 3],
          },
        ],
      },
    ],
    ...over,
  });
}

/** The same spine with one lesson field replaced, for the per-rule cases. */
function courseWithLesson(over: Record<string, unknown>) {
  return course({
    units: [
      {
        id: 1,
        title: "Meeting people",
        outcome: "You can greet someone and be understood.",
        lessons: [
          {
            id: 1,
            title: "Hello and goodbye",
            outcome: "You can say hello and goodbye.",
            activityIds: [1, 2, 3],
            ...over,
          },
        ],
      },
    ],
  });
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

  it("names what is wrong in what it throws", async () => {
    /**
     * `npm run seed-content` publishes through this same function, and its
     * whole output is a log line. "Invalid set for fr" would send whoever ran
     * it to a debugger; the reason belongs in the error.
     */
    await expect(
      publish(fakeDb(), set({ activities: [activity({ target: "" })] }), 1),
    ).rejects.toThrow(/target cannot be empty/);
  });

  it("refuses a set whose rows would be dropped rather than publishing what survives", async () => {
    /**
     * The one place the read path's leniency would do real harm. `readContent`
     * drops a bad row so one typo cannot take down a language — correct when
     * serving. On the way in it would mean publishing nine of the ten
     * activities somebody typed and reporting success, so `publish` refuses
     * the whole set instead.
     */
    const activities = [activity({ id: 1 }), activity({ id: 2, target: "" }), activity({ id: 3 })];

    await expect(publish(fakeDb(), set({ activities }), 1)).rejects.toThrow(/activity 2/);
    expect(store).toHaveLength(0);
  });
});

/**
 * The rules the publish gate applies, stated once and shared by everything
 * that can publish: `npm run seed-content` and the authoring screen both go
 * through `publish`, which goes through here.
 *
 * These are the rules src/activities/languages/languages.test.ts already holds
 * the bundle to. That test is the whole of the validation seed-content has ever
 * had — its input is the bundle, and the bundle cannot land without passing it.
 * An authoring screen has no test standing in front of it, so the same rules
 * have to exist at runtime.
 */
describe("what may be published", () => {
  it("accepts a well-formed set with nothing to say about it", () => {
    expect(contentProblems({ ...set(), version: 1 })).toEqual([]);
  });

  it.each([
    ["a bad slug", { slug: "FR" }, /slug/],
    ["a locale the provider will reject", { code: "french" }, /locale/],
    ["a whitespace label", { label: "   " }, /label/],
    ["no activities", { activities: [] }, /at least one activity/],
    ["activities that are not a list", { activities: {} }, /must be a list/],
    ["a kind the UI cannot render", { activities: [activity({ kind: "sing" })] }, /kind must be one of/],
    ["a whitespace target", { activities: [activity({ target: " " })] }, /target cannot be empty/],
    ["a fractional id", { activities: [activity({ id: 1.5 })] }, /whole number/],
    [
      "a duplicate id",
      { activities: [activity({ id: 1 }), activity({ id: 1, target: "Bonsoir" })] },
      /already used/,
    ],
    ["a duplicate target", { activities: [activity({ id: 1 }), activity({ id: 2 })] }, /repeats/],
    [
      "a target past the capture ceiling",
      { activities: [activity({ target: "un ".repeat(15) })] },
      /cut off mid-phrase/,
    ],
  ])("refuses %s", (_label, over, expected) => {
    const problems = contentProblems({ ...set(), version: 1, ...over });

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(" | ")).toMatch(expected);
  });

  it("counts activities from one, so a problem names the row an author is looking at", () => {
    const activities = [activity({ id: 1 }), activity({ id: 2, target: "" })];

    expect(contentProblems({ ...set(), version: 1, activities })).toEqual([
      "activity 2: target cannot be empty",
    ]);
  });

  it("normalises whitespace rather than refusing over it", () => {
    /**
     * A trailing space is the likeliest thing to survive a copy-paste. Refusing
     * the publish over one would teach an author to distrust the screen;
     * storing it would put it in front of the scorer.
     */
    const draft = readDraft(set({ label: " French ", activities: [activity({ target: " Bonjour " })] }));

    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.set.label).toBe("French");
    expect(draft.set.activities[0]?.target).toBe("Bonjour");
  });

  it("takes the slug it was given and nothing else from the caller", () => {
    // The route supplies the slug from the path; a body that could carry its
    // own is a way to publish French content under the Spanish slug.
    const draft = readDraft(set());

    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(Object.keys(draft.set).sort()).toEqual(["activities", "code", "label", "slug"]);
  });
});

/**
 * The serving path's own tolerance, which is the opposite posture on purpose:
 * a bad row costs that row and the language stays up, because the alternative
 * is a learner staring at an empty screen.
 */
describe("what may be served", () => {
  it("drops an activity with a kind the UI cannot render", () => {
    /**
     * src/content/cache.ts has always required one of the three kinds, so a
     * set carrying `kind: "reppeat"` used to pass the server, be served
     * happily, and then be discarded by every client's own validation —
     * whoever published it saw success and no learner ever received it.
     */
    const content = readContent({
      ...set(),
      version: 1,
      activities: [activity({ id: 1 }), activity({ id: 2, kind: "reppeat", target: "Bonsoir" })],
    });

    expect(content?.activities.map((a) => a.id)).toEqual([1]);
  });

  it("drops an activity whose target is only whitespace", () => {
    // Speech scored against nothing — the empty-target failure in a disguise.
    expect(readContent({ ...set(), version: 1, activities: [activity({ target: "  " })] })).toBeNull();
  });

  it("serves one activity per id, keeping the first", () => {
    /**
     * `id` is the React key, the progress key and what the report joins on, so
     * two rows sharing one silently merge two activities' attempts — a learner
     * who passes one appears to have passed the other. The publish gate refuses
     * this outright; this is the document edited straight into the database.
     */
    const content = readContent({
      ...set(),
      version: 1,
      activities: [activity({ id: 1, title: "first" }), activity({ id: 1, title: "second" })],
    });

    expect(content?.activities).toHaveLength(1);
    expect(content?.activities[0]?.title).toBe("first");
  });
});

describe("the version history", () => {
  it("summarises what is published, newest first", async () => {
    const db = fakeDb();
    await publish(db, set(), 1);
    await publish(db, set({ activities: [activity(), activity({ id: 2, target: "Bonsoir" })] }), 2);

    const versions = await listVersions(db, "fr");

    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions.map((v) => v.activityCount)).toEqual([2, 1]);
    expect(versions[0]?.publishedAt).toBeInstanceOf(Date);
  });

  it("has nothing to say about a language nobody has published", async () => {
    expect(await listVersions(fakeDb(), "de")).toEqual([]);
  });

  it("reads one named version rather than the newest", async () => {
    const db = fakeDb();
    await publish(db, set(), 1);
    await publish(db, set({ activities: [activity({ target: "Bonsoir" })] }), 2);

    expect((await readVersion(db, "fr", 1))?.activities[0]?.target).toBe("Bonjour");
    expect(await readVersion(db, "fr", 9)).toBeNull();
  });

  it("hands back a version that would fail validation, because that is the one to fix", async () => {
    /**
     * Deliberately unvalidated. This is what the authoring screen loads into
     * the editor, and a set that fails validation is precisely the one somebody
     * needs to open and repair — validating here would hide the broken version
     * from the only screen that can fix it, which is a database client again.
     */
    store = [
      { ...set(), _id: "fr:1", version: 1, activities: [], publishedAt: new Date() } as ContentDocument,
    ];

    expect((await readVersion(fakeDb(), "fr", 1))?.activities).toEqual([]);
    // And the learner's path still refuses it, so nobody is served it.
    expect(await readLatest("fr")).toBeNull();
  });
});

/**
 * The course spine — `Unit → Lesson → Activity` — and the field it exists to
 * make usable.
 *
 * Every rule here is about a *relationship*, which is what makes them worth
 * runtime checks: a lesson pointing at an activity that does not exist, an
 * activity in two lessons, an activity in none. Each of those is a valid JSON
 * document and each fails invisibly — a sitting that ends early, one take
 * counted twice, content nobody can reach — so none of them would be reported
 * by the thing that broke.
 */
describe("publishing a set with a course spine", () => {
  it("accepts a well-formed course", () => {
    expect(contentProblems({ ...course(), version: 1 })).toEqual([]);
  });

  it("still accepts a set with no spine at all", () => {
    /**
     * The compatibility claim, as a test. Three of the four shipped languages
     * are flat, and content is immutable — so the spine has to arrive as a new
     * version rather than as a requirement imposed on documents that already
     * exist.
     */
    expect(contentProblems({ ...set(), version: 1 })).toEqual([]);
    expect("units" in set()).toBe(false);
  });

  it("refuses an activity in a lesson with no sound targets", () => {
    /**
     * The field `selectActivity` has been waiting on. A lesson is what the
     * scheduler picks from, so an activity inside one with no mapping is one
     * it can only ever offer as a fallback — the first-unpassed activity
     * wearing the word "recommended", which GET /next refused to ship.
     */
    const activities = courseActivities();
    const [first, ...rest] = activities;
    const withoutMapping = { ...first };
    delete (withoutMapping as Record<string, unknown>)["soundTargets"];

    const problems = contentProblems({
      ...course({ activities: [withoutMapping, ...rest] }),
      version: 1,
    });

    expect(problems.join(" | ")).toMatch(/soundTargets cannot be empty in a set with units/);
  });

  it("refuses an empty sound target list in the same way as a missing one", () => {
    // Otherwise "no mapping" would have two spellings and only one of them
    // would be caught.
    const activities = courseActivities();
    const [first, ...rest] = activities;

    const problems = contentProblems({
      ...course({ activities: [{ ...first, soundTargets: [] }, ...rest] }),
      version: 1,
    });

    expect(problems.join(" | ")).toMatch(/soundTargets cannot be empty/);
  });

  it("lets a flat set publish with no sound targets, because the scheduler has a fallback", () => {
    expect(contentProblems({ ...set(), version: 1 })).toEqual([]);
  });

  it.each([
    [
      "a lesson pointing at an activity that is not in the set",
      courseWithLesson({ activityIds: [1, 2, 99] }),
      /activity 99 is not in this set/,
    ],
    [
      "a lesson shorter than one sitting",
      courseWithLesson({ activityIds: [1, 2] }),
      /a lesson is one sitting/,
    ],
    [
      "a lesson longer than one sitting",
      course({
        activities: [
          ...courseActivities(),
          activity({ id: 4, target: "Salut", soundTargets: ["sa"] }),
          activity({ id: 5, target: "Adieu", soundTargets: ["dieu"] }),
          activity({ id: 6, target: "Pardon", soundTargets: ["par"] }),
          activity({ id: 7, target: "Voilà", soundTargets: ["voi"] }),
        ],
        units: [
          {
            id: 1,
            title: "Everything at once",
            outcome: "You can say seven things.",
            lessons: [
              {
                id: 1,
                title: "All of it",
                outcome: "You can say all of it.",
                activityIds: [1, 2, 3, 4, 5, 6, 7],
              },
            ],
          },
        ],
      }),
      /outlasts the sitting it was sized for/,
    ],
    [
      "an activity in no lesson",
      course({
        activities: [...courseActivities(), activity({ id: 4, target: "Salut", soundTargets: ["sa"] })],
      }),
      /are in no lesson/,
    ],
    [
      "an activity in two lessons",
      course({
        activities: [
          ...courseActivities(),
          activity({ id: 4, target: "Salut", soundTargets: ["sa"] }),
          activity({ id: 5, target: "Adieu", soundTargets: ["dieu"] }),
        ],
        units: [
          {
            id: 1,
            title: "Meeting people",
            outcome: "You can greet someone.",
            lessons: [
              { id: 1, title: "One", outcome: "You can say hello.", activityIds: [1, 2, 3] },
              { id: 2, title: "Two", outcome: "You can say goodbye.", activityIds: [3, 4, 5] },
            ],
          },
        ],
      }),
      /already in unit 1 lesson 1/,
    ],
    [
      "two lessons sharing an id across units",
      course({
        activities: [
          ...courseActivities(),
          activity({ id: 4, target: "Salut", soundTargets: ["sa"] }),
          activity({ id: 5, target: "Adieu", soundTargets: ["dieu"] }),
          activity({ id: 6, target: "Pardon", soundTargets: ["par"] }),
        ],
        units: [
          {
            id: 1,
            title: "One",
            outcome: "You can say hello.",
            lessons: [{ id: 1, title: "A", outcome: "You can say hello.", activityIds: [1, 2, 3] }],
          },
          {
            id: 2,
            title: "Two",
            outcome: "You can say goodbye.",
            lessons: [{ id: 1, title: "B", outcome: "You can say goodbye.", activityIds: [4, 5, 6] }],
          },
        ],
      }),
      /already used by another lesson/,
    ],
    [
      "a unit with no outcome",
      course({
        units: [
          {
            id: 1,
            title: "Meeting people",
            outcome: "  ",
            lessons: [
              { id: 1, title: "Hello", outcome: "You can say hello.", activityIds: [1, 2, 3] },
            ],
          },
        ],
      }),
      /the can-do statement the unit exists to earn/,
    ],
    [
      "a unit with no lessons",
      course({
        units: [{ id: 1, title: "Meeting people", outcome: "You can greet.", lessons: [] }],
      }),
      /needs at least one lesson/,
    ],
    [
      "an empty units list, which is not the same claim as no units",
      course({ units: [] }),
      /leave it out entirely/,
    ],
  ])("refuses %s", (_label, candidate, expected) => {
    const problems = contentProblems({ ...candidate, version: 1 });

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(" | ")).toMatch(expected);
  });

  it("names a spine problem by the unit and lesson an author is looking at", () => {
    // "activityIds must be a list" with no position is a hunt through six
    // lessons, which is the state this screen exists to remove.
    const problems = contentProblems({ ...courseWithLesson({ title: "" }), version: 1 });

    expect(problems).toContain("unit 1 lesson 1: title cannot be empty");
  });
});

describe("the sound targets themselves", () => {
  it("refuses a syllable that does not occur in the phrase", () => {
    /**
     * The mistake that looks right: somebody corrects a phrase and leaves the
     * syllables alone. The scorer can only ever name syllables of the
     * reference text, so those entries match nothing for ever — and the
     * activity goes on claiming a mapping it does not have.
     */
    const problems = contentProblems({
      ...set({ activities: [activity({ target: "Bonjour", soundTargets: ["merci"] })] }),
      version: 1,
    });

    expect(problems.join(" | ")).toMatch(/does not appear in the target/);
  });

  it("refuses a phonetic symbol, which is the obvious thing to type", () => {
    // `focus` is where IPA belongs. A grapheme is matched against the
    // reference text's own orthography, so /ʁ/ maps to nothing.
    const problems = contentProblems({
      ...set({ activities: [activity({ target: "Bonjour", soundTargets: ["/ʁ/"] })] }),
      version: 1,
    });

    expect(problems.join(" | ")).toMatch(/not a written syllable/);
  });

  it("refuses the same syllable listed twice", () => {
    const problems = contentProblems({
      ...set({ activities: [activity({ target: "Bonjour", soundTargets: ["bon", "Bon"] })] }),
      version: 1,
    });

    expect(problems.join(" | ")).toMatch(/listed twice/);
  });

  it("accepts a capital and stores it folded, rather than refusing over case", () => {
    /**
     * The skills store folds a grapheme to lower case on the way in, so a
     * published "Bon" would be a mapping that never matches the "bon" a
     * learner's history is keyed on. Refusing the publish over a capital
     * letter would be pedantry; storing one would be a silent no-op.
     */
    const draft = readDraft(
      set({ activities: [activity({ target: "Bonjour", soundTargets: [" Bon "] })] }),
    );

    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.set.activities[0]?.soundTargets).toEqual(["bon"]);
  });

  it("leaves the key off entirely when nothing was authored", () => {
    // One representation for "no mapping", so the rule that requires one in a
    // course set has a single thing to check.
    const draft = readDraft(set());

    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect("soundTargets" in (draft.set.activities[0] ?? {})).toBe(false);
    expect(Object.keys(draft.set).sort()).toEqual(["activities", "code", "label", "slug"]);
  });

  it("carries the spine through normalisation", () => {
    const draft = readDraft(course());

    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(Object.keys(draft.set).sort()).toEqual(["activities", "code", "label", "slug", "units"]);
    expect(draft.set.units?.[0]?.lessons[0]?.activityIds).toEqual([1, 2, 3]);
  });

  it("refuses to publish a course it would refuse to describe", async () => {
    // `publish` runs the same gate, so seed-content and the authoring screen
    // cannot differ about what a course is.
    await expect(publish(fakeDb(), courseWithLesson({ activityIds: [1, 2] }), 1)).rejects.toThrow(
      /one sitting/,
    );
    expect(store).toHaveLength(0);
  });
});

/**
 * Serving a course, which is the opposite posture again: a spine that does not
 * hold up costs the spine, never the language.
 */
describe("what may be served with a spine", () => {
  it("serves the spine when it holds up", () => {
    const content = readContent({ ...course(), version: 1 });

    expect(content?.units?.[0]?.lessons[0]?.activityIds).toEqual([1, 2, 3]);
  });

  it("falls back to the flat set when the spine does not hold up", async () => {
    /**
     * A course with a hole in it is worse than no course: the flat list is a
     * shape every screen already handles, and a journey missing a lesson shows
     * nothing that says so. Logged, because otherwise it looks from outside
     * like the Journey screen being broken.
     */
    const { logger } = await import("../logger.js");
    const content = readContent({ ...courseWithLesson({ activityIds: [1, 2, 99] }), version: 1 });

    expect(content?.activities).toHaveLength(3);
    expect(content?.units).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "fr" }),
      expect.stringMatching(/spine failed validation/),
    );
  });

  it("drops the spine when a lesson points at an activity that was itself dropped", () => {
    /**
     * The two leniencies interacting. A bad activity row is dropped so one
     * typo cannot take down a language — but a lesson still pointing at it
     * would produce a sitting that ends early on a blank screen, so the spine
     * goes with it.
     */
    const activities = courseActivities();
    const [first, second, third] = activities;
    const content = readContent({
      ...course({ activities: [first, second, { ...third, target: "" }] }),
      version: 1,
    });

    expect(content?.activities.map((a) => a.id)).toEqual([1, 2]);
    expect(content?.units).toBeUndefined();
  });

  it("keeps sound targets, folded, and drops only the entries it cannot use", () => {
    const content = readContent({
      ...set({
        activities: [activity({ target: "Bonjour", soundTargets: ["Bon", "/ʁ/", "jour", 7] })],
      }),
      version: 1,
    });

    expect(content?.activities[0]?.soundTargets).toEqual(["bon", "jour"]);
  });

  it("serves a recall activity, which no client older than the spine can render", () => {
    /**
     * The fourth kind. An old client's own validation drops it — which is the
     * designed outcome, not a bug: it loses that row and keeps the language,
     * rather than rendering a blank task.
     */
    const content = readContent({
      ...set({ activities: [activity({ kind: "recall" })] }),
      version: 1,
    });

    expect(content?.activities[0]?.kind).toBe("recall");
  });
});
