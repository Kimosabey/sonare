/**
 * The authoring endpoints — the only write in the product that changes what a
 * learner is asked to say aloud.
 *
 * Four things are worth more than the rest here, and each one is a way this
 * could be worse than having no authoring screen at all.
 *
 * **It must refuse an unusable set.** An authoring UI that can publish a
 * broken language hands a foot-gun to the one person who cannot read the stack
 * trace. Every refusal below is asserted on the *response*, not on a store
 * function, because the route is what an author actually meets.
 *
 * **It must fail closed.** Same posture as the diagnostics gate it borrows:
 * with no `DIAGNOSTICS_TOKEN` set, publishing is not open, it is off. A
 * forgotten environment variable must not be the difference between an
 * internal tool and a public write endpoint.
 *
 * **The learner's read must stay open.** `GET /content/:slug` is fetched
 * before anybody has registered and is the mechanism behind the offline
 * fallback. If the token gate leaks onto it, every learner silently reverts to
 * the bundle — a failure that looks like nothing happening.
 *
 * **The version must come from the server.** A body that names its own version
 * can overwrite one, or skip ahead and strand every later correction behind a
 * gap.
 *
 * Real Express on an ephemeral port; the database is a fake. The routes are
 * what is under test.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Db } from "mongodb";
import type { ContentDocument } from "../store/content.js";

let store: ContentDocument[] = [];
let dbFails = false;

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../rateLimit.js", () => ({
  diagnosticsLimiter: (_q: unknown, _s: unknown, next: () => void) => next(),
  scoringLimiter: (_q: unknown, _s: unknown, next: () => void) => next(),
}));

vi.mock("../db.js", () => ({
  getDb: () => (dbFails ? Promise.reject(new Error("no connection")) : Promise.resolve(fakeDb())),
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

const TOKEN = "s3cret-authoring-token";
const ORIGINAL = process.env.DIAGNOSTICS_TOKEN;

let server: Server;
let base: string;

/**
 * Set here, at the top level, before the router is imported. A nested
 * `beforeAll` would configure a *different* module instance than the one the
 * running app holds — four assertions once passed for that reason, against
 * nothing.
 */
beforeAll(async () => {
  process.env.DIAGNOSTICS_TOKEN = TOKEN;
  const express = (await import("express")).default;
  const { contentRouter } = await import("./content.js");
  const app = express();
  app.use(express.json());
  app.use("/api/v1", contentRouter);
  await new Promise<void>((ready) => {
    server = app.listen(0, () => ready());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (ORIGINAL === undefined) delete process.env.DIAGNOSTICS_TOKEN;
  else process.env.DIAGNOSTICS_TOKEN = ORIGINAL;
  await new Promise<void>((done) => server.close(() => done()));
});

beforeEach(() => {
  store = [];
  dbFails = false;
  process.env.DIAGNOSTICS_TOKEN = TOKEN;
});

afterEach(() => {
  vi.clearAllMocks();
});

const auth = { "x-diagnostics-token": TOKEN };

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

/** A publishable body: the shape the screen sends. */
function body(over: Record<string, unknown> = {}) {
  return {
    code: "fr-FR",
    label: "French",
    baseVersion: 0,
    activities: [activity()],
    ...over,
  };
}

function post(slug: string, payload: unknown, headers: Record<string, string> = auth) {
  return fetch(`${base}/api/v1/content/${slug}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function seed(version: number, over: Record<string, unknown> = {}): void {
  store.push({
    _id: `fr:${version}`,
    slug: "fr",
    code: "fr-FR",
    label: "French",
    version,
    activities: [activity()],
    publishedAt: new Date("2026-01-01"),
    ...over,
  } as ContentDocument);
}

describe("the gate in front of publishing", () => {
  it("refuses a publish with no token", async () => {
    const response = await post("fr", body(), {});

    expect(response.status).toBe(401);
    expect(store).toHaveLength(0);
  });

  it("refuses a publish with the wrong token", async () => {
    const response = await post("fr", body(), { "x-diagnostics-token": "not-it" });

    expect(response.status).toBe(401);
    expect(store).toHaveLength(0);
  });

  it("fails closed when the secret is unset — publishing is off, not open", async () => {
    /**
     * The property the whole gate rests on. If an unset variable meant "no
     * check", a forgotten line of .env would be the difference between an
     * internal tool and a write endpoint anybody can reach.
     */
    delete process.env.DIAGNOSTICS_TOKEN;

    const response = await post("fr", body(), {});

    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toMatch(/disabled/);
    expect(store).toHaveLength(0);
  });

  it("gates the version list and the version read too", async () => {
    seed(1);

    expect((await fetch(`${base}/api/v1/content/fr/versions`)).status).toBe(401);
    expect((await fetch(`${base}/api/v1/content/fr/versions/1`)).status).toBe(401);
  });

  it("leaves the learner's read open, which is what the offline fallback needs", async () => {
    /**
     * Fetched before anybody has registered, and by a client that has no token
     * to send. A gate leaking onto this endpoint would silently revert every
     * learner to the bundled set — a failure that looks like nothing at all.
     */
    seed(1);

    const response = await fetch(`${base}/api/v1/content/fr`);

    expect(response.status).toBe(200);
    expect(((await response.json()) as { version: number }).version).toBe(1);
  });
});

describe("refusing a set it could not serve", () => {
  /**
   * Each row is a set that would reach a learner as something broken, and each
   * is asserted twice: the response is a 422, and nothing was written. A
   * refusal that still published would be the worst outcome available.
   */
  it.each([
    ["no activities at all", { activities: [] }],
    ["activities that are not a list", { activities: "Bonjour" }],
    ["nothing usable in the list", { activities: [null, 7, "x"] }],
    ["an activity with no target to score against", { activities: [activity({ target: "" })] }],
    ["a target of only whitespace", { activities: [activity({ target: "   " })] }],
    ["an activity with no instruction", { activities: [activity({ prompt: "" })] }],
    ["an activity with no gloss", { activities: [activity({ gloss: "" })] }],
    ["an activity with no focus", { activities: [activity({ focus: "" })] }],
    ["an activity with no title", { activities: [activity({ title: "" })] }],
    ["a kind the UI cannot render", { activities: [activity({ kind: "reppeat" })] }],
    ["no kind", { activities: [activity({ kind: "" })] }],
    ["a duplicate id", { activities: [activity({ id: 1 }), activity({ id: 1, target: "Bonsoir" })] }],
    ["a fractional id", { activities: [activity({ id: 1.5 })] }],
    ["an id of zero", { activities: [activity({ id: 0 })] }],
    ["an id that is not a number", { activities: [activity({ id: "1" })] }],
    ["a duplicate target", { activities: [activity({ id: 1 }), activity({ id: 2 })] }],
    ["a target longer than the capture ceiling", { activities: [activity({ target: "un ".repeat(15) })] }],
    ["no label", { label: "" }],
    ["a label of only whitespace", { label: "  " }],
    ["a locale the provider will reject", { code: "french" }],
    ["no locale", { code: "" }],
    ["more activities than a document should hold", {
      activities: Array.from({ length: 51 }, (_, i) => activity({ id: i + 1, target: `phrase ${i}` })),
    }],
  ])("refuses %s, and writes nothing", async (_label, over) => {
    const response = await post("fr", body(over));

    expect(response.status).toBe(422);
    expect(store).toHaveLength(0);
  });

  it("names what is wrong rather than just saying no", async () => {
    /**
     * The difference between this screen working and this screen needing an
     * engineer. "Invalid" sends the author back to the person they were trying
     * to stop depending on.
     */
    const response = await post("fr", body({ activities: [activity({ target: "", kind: "sing" })] }));
    const payload = (await response.json()) as { problems: string[] };

    expect(payload.problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("target cannot be empty"),
        expect.stringContaining("kind must be one of"),
      ]),
    );
    // Named by position, so a set of ten says which row.
    expect(payload.problems.every((p) => p.startsWith("activity 1:"))).toBe(true);
  });

  it("refuses a slug that is not a language slug before it reaches a document id", async () => {
    /**
     * The slug becomes `{slug}:{version}` as the primary key and this route
     * writes with it, so it is checked rather than trusted.
     *
     * Percent-encoded on purpose: a literal `../etc` in the path is collapsed
     * by the URL parser before the request is even sent, so testing that shape
     * would assert on `fetch`'s normalisation and prove nothing about the
     * route. Encoded, it arrives intact and Express hands `../etc` to the
     * handler as the slug — which is the shape that has to be refused.
     */
    expect((await post("%2E%2E%2Fetc", body())).status).toBe(400);
    expect((await post("FR", body())).status).toBe(400);
    expect((await post("f", body())).status).toBe(400);
    expect(store).toHaveLength(0);
  });

  it("refuses a body that is not a set at all", async () => {
    const response = await fetch(`${base}/api/v1/content/fr`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ baseVersion: 0 }),
    });

    expect(response.status).toBe(422);
    expect(store).toHaveLength(0);
  });

  it("keeps every activity when the set is good — nothing is silently dropped", async () => {
    /**
     * The counterpart to refusing. `readContent` drops a bad row on the *read*
     * path so one typo cannot take down a language; on the publish path that
     * same leniency would mean publishing nine of the ten activities somebody
     * typed and reporting success. So a good set keeps all of them, and a bad
     * one is refused whole — never partially published.
     */
    const activities = Array.from({ length: 10 }, (_, i) =>
      activity({ id: i + 1, target: `phrase ${i + 1}` }),
    );

    const response = await post("fr", body({ activities }));

    expect(response.status).toBe(201);
    expect(((await response.json()) as { activityCount: number }).activityCount).toBe(10);
    expect(store[0]?.activities).toHaveLength(10);
  });
});

describe("publishing the next version", () => {
  it("publishes version 1 for a language nobody has published", async () => {
    const response = await post("fr", body({ baseVersion: 0 }));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ slug: "fr", version: 1, activityCount: 1 });
    expect(store[0]?._id).toBe("fr:1");
  });

  it("assigns the version itself, ignoring anything the body says", async () => {
    /**
     * A body that could name its own version could name one that exists and
     * overwrite it, or skip to 99 and leave every later correction stranded
     * behind a gap it can never fill.
     */
    seed(1);

    const response = await post("fr", body({ baseVersion: 1, version: 99, _id: "fr:99" }));

    expect(response.status).toBe(201);
    expect(((await response.json()) as { version: number }).version).toBe(2);
    expect(store.map((d) => d._id)).toEqual(["fr:1", "fr:2"]);
  });

  it("never touches the version it published from", async () => {
    // Immutability is the property that stops a learner mid-session being
    // handed different words for the same activity.
    seed(1);

    await post("fr", body({ baseVersion: 1, label: "Français" }));

    expect(store).toHaveLength(2);
    expect(store.find((d) => d.version === 1)?.label).toBe("French");
    expect(store.find((d) => d.version === 2)?.label).toBe("Français");
  });

  it("trims what an author pasted rather than storing it", async () => {
    await post("fr", body({ label: " French ", activities: [activity({ target: " Bonjour " })] }));

    expect(store[0]?.label).toBe("French");
    expect(store[0]?.activities[0]?.target).toBe("Bonjour");
  });

  it("becomes the set the learner's read serves", async () => {
    // The whole loop, end to end: publish, then the unauthenticated endpoint
    // every client actually calls returns it.
    await post("fr", body({ activities: [activity({ target: "Bonsoir" })] }));

    const served = (await (await fetch(`${base}/api/v1/content/fr`)).json()) as {
      version: number;
      activities: { target: string }[];
    };

    expect(served.version).toBe(1);
    expect(served.activities[0]?.target).toBe("Bonsoir");
  });

  it("publishes an older version forward, which is how a rollback happens", async () => {
    /**
     * `baseVersion` is the newest version the author had *seen*, not the one
     * loaded into the editor — otherwise opening version 1 while 2 is current
     * would read as a conflict with itself and rollback would be impossible.
     */
    seed(1, { activities: [activity({ target: "Bonjour" })] });
    seed(2, { _id: "fr:2", activities: [activity({ target: "Bonsoir" })] });

    const response = await post("fr", body({ baseVersion: 2, activities: [activity()] }));

    expect(response.status).toBe(201);
    expect(store.find((d) => d.version === 3)?.activities[0]?.target).toBe("Bonjour");
  });
});

describe("two authors at once", () => {
  it("refuses a publish based on a version that is no longer the newest", async () => {
    /**
     * The plain lost update. Two people open the screen at version 1, both
     * edit, and without this the second publish becomes version 3 — the first
     * person's corrections are gone from the newest set while looking
     * published, which is the kind of loss nobody notices for a month.
     */
    seed(1);
    seed(2, { _id: "fr:2" });

    const response = await post("fr", body({ baseVersion: 1 }));
    const payload = (await response.json()) as { currentVersion: number };

    expect(response.status).toBe(409);
    // Told what the current version is, so the screen can say what to do.
    expect(payload.currentVersion).toBe(2);
    expect(store).toHaveLength(2);
  });

  it("reports a collision during the write as a conflict, not as an outage", async () => {
    /**
     * The same situation caught a moment later — between reading the latest
     * version and inserting. A 503 here would tell an author the database is
     * down when the right advice is to reload.
     */
    seed(1);
    // The id version 2 will be assigned already exists but carries a
    // different slug field, so latestVersion does not see it.
    store.push({
      _id: "fr:2",
      slug: "elsewhere",
      code: "fr-FR",
      label: "French",
      version: 2,
      activities: [activity()],
      publishedAt: new Date(),
    } as ContentDocument);

    const response = await post("fr", body({ baseVersion: 1 }));

    expect(response.status).toBe(409);
    expect(store).toHaveLength(2);
  });

  it("requires baseVersion rather than guessing at it", async () => {
    // Absent, it would have to default — and defaulting to "whatever is
    // current" is exactly the lost update the field exists to catch.
    const response = await post("fr", { code: "fr-FR", label: "French", activities: [activity()] });

    expect(response.status).toBe(400);
    expect(store).toHaveLength(0);
  });
});

describe("the version history", () => {
  it("lists what is published, newest first", async () => {
    seed(1);
    seed(2, { _id: "fr:2", activities: [activity(), activity({ id: 2, target: "Bonsoir" })] });

    const response = await fetch(`${base}/api/v1/content/fr/versions`, { headers: auth });
    const payload = (await response.json()) as {
      versions: { version: number; activityCount: number }[];
    };

    expect(payload.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(payload.versions[0]?.activityCount).toBe(2);
  });

  it("answers an empty list for a language nobody has published", async () => {
    /**
     * Not a 404. The screen's next move is to offer the bundled set as a
     * starting point, and it needs to be told there is nothing rather than
     * that the request failed.
     */
    const response = await fetch(`${base}/api/v1/content/de/versions`, { headers: auth });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { versions: unknown[] }).versions).toEqual([]);
  });

  it("returns one version whole, for loading into the editor", async () => {
    seed(1);

    const response = await fetch(`${base}/api/v1/content/fr/versions/1`, { headers: auth });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ slug: "fr", version: 1, label: "French" });
  });

  it("hands back a version that would fail validation, because that is the one to fix", async () => {
    /**
     * The read a learner gets refuses an unusable set and falls back to the
     * bundle. This read must not, or the broken version is invisible to the
     * only screen that can repair it — which is a Mongo client again.
     */
    seed(1, { activities: [activity({ kind: "reppeat" })] });

    const response = await fetch(`${base}/api/v1/content/fr/versions/1`, { headers: auth });
    const payload = (await response.json()) as { activities: { kind: string }[] };

    expect(response.status).toBe(200);
    expect(payload.activities[0]?.kind).toBe("reppeat");
    // And the learner's own read still refuses it, so nobody is served it.
    expect((await fetch(`${base}/api/v1/content/fr`)).status).toBe(404);
  });

  it("refuses a version that is not a whole number", async () => {
    expect((await fetch(`${base}/api/v1/content/fr/versions/0`, { headers: auth })).status).toBe(400);
    expect((await fetch(`${base}/api/v1/content/fr/versions/x`, { headers: auth })).status).toBe(400);
  });

  it("404s a version nobody published", async () => {
    seed(1);

    expect((await fetch(`${base}/api/v1/content/fr/versions/9`, { headers: auth })).status).toBe(404);
  });

  it("reports an unreachable database as an outage rather than as no history", async () => {
    // An empty list would read as "nothing has ever been published", which is
    // the cue to start a first draft over the top of real content.
    dbFails = true;

    expect((await fetch(`${base}/api/v1/content/fr/versions`, { headers: auth })).status).toBe(503);
  });
});

/**
 * The course spine across the wire, which is where it would be dropped without
 * anybody noticing: the route builds its responses from a written-out list of
 * fields, so a field added to the document and not to the list validates,
 * stores, and never arrives.
 */
describe("publishing and serving a course", () => {
  const courseActivities = [
    activity({ id: 1, target: "Bonjour", soundTargets: ["bon", "jour"] }),
    activity({ id: 2, target: "Bonsoir", soundTargets: ["soir"] }),
    activity({ id: 3, target: "Merci", soundTargets: ["mer"] }),
  ];

  const units = [
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
  ];

  it("publishes a spine and serves it back to a learner", async () => {
    const response = await post("fr", body({ activities: courseActivities, units }));
    expect(response.status).toBe(201);

    const served = (await (await fetch(`${base}/api/v1/content/fr`)).json()) as {
      units?: { lessons: { activityIds: number[] }[] }[];
      activities: { soundTargets?: string[] }[];
    };

    expect(served.units?.[0]?.lessons[0]?.activityIds).toEqual([1, 2, 3]);
    expect(served.activities[0]?.soundTargets).toEqual(["bon", "jour"]);
  });

  it("publishes the spine as a new version, leaving the flat one exactly as it was", async () => {
    /**
     * The property the whole content store is built on, and the one this
     * change had to respect rather than work around: the spine is not a
     * migration of `fr:1`. It is `fr:2`, and a learner mid-sitting keeps the
     * words — and the shape — they started being scored against.
     */
    seed(1);

    const response = await post("fr", body({ baseVersion: 1, activities: courseActivities, units }));

    expect(response.status).toBe(201);
    expect(store.map((d) => d._id)).toEqual(["fr:1", "fr:2"]);
    expect(store[0]?.units).toBeUndefined();
    expect(store[0]?.activities).toHaveLength(1);
    expect(store[1]?.units).toHaveLength(1);
  });

  it("refuses a spine whose lesson names an activity that is not there", async () => {
    const broken = [
      { ...units[0], lessons: [{ ...units[0]?.lessons[0], activityIds: [1, 2, 99] }] },
    ];

    const response = await post("fr", body({ activities: courseActivities, units: broken }));
    const payload = (await response.json()) as { problems?: string[] };

    expect(response.status).toBe(422);
    expect(payload.problems?.join(" | ")).toMatch(/is not in this set/);
    expect(store).toHaveLength(0);
  });

  it("refuses a course whose activities carry no sound targets", async () => {
    const withoutMapping = courseActivities.map((a) => {
      const copy = { ...a };
      delete (copy as Record<string, unknown>)["soundTargets"];
      return copy;
    });

    const response = await post("fr", body({ activities: withoutMapping, units }));
    const payload = (await response.json()) as { problems?: string[] };

    expect(response.status).toBe(422);
    expect(payload.problems?.join(" | ")).toMatch(/soundTargets cannot be empty/);
    expect(store).toHaveLength(0);
  });

  it("still accepts a flat publish from a client that has never heard of units", async () => {
    /**
     * The other half of the compatibility claim. A client built before the
     * spine sends no `units` key at all, and that has to stay a valid publish
     * rather than becoming an implicit empty course.
     */
    const response = await post("fr", body());

    expect(response.status).toBe(201);
    expect(store[0]?.units).toBeUndefined();
  });

  it("hands the spine back unvalidated on the version read, because that is the one to repair", async () => {
    seed(1, {
      activities: courseActivities,
      units: [{ ...units[0], lessons: [{ ...units[0]?.lessons[0], activityIds: [1, 2, 99] }] }],
    });

    const payload = (await (
      await fetch(`${base}/api/v1/content/fr/versions/1`, { headers: auth })
    ).json()) as { units?: { lessons: { activityIds: number[] }[] }[] };

    expect(payload.units?.[0]?.lessons[0]?.activityIds).toEqual([1, 2, 99]);
    // And the learner's read drops the spine rather than serving a hole in it.
    const served = (await (await fetch(`${base}/api/v1/content/fr`)).json()) as {
      units?: unknown;
      activities: unknown[];
    };
    expect(served.units).toBeUndefined();
    expect(served.activities).toHaveLength(3);
  });
});
