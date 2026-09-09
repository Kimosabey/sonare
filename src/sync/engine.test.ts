// @vitest-environment jsdom

/**
 * Offline-first sync, tested by the promises it makes rather than the calls it
 * makes.
 *
 * Three of them, and each has a way of being broken silently:
 *
 * A failure costs nothing. The dirty flags survive, so the work is pushed on
 * the next attempt — and no error reaches the learner, because there is
 * nothing for them to do and "your progress failed to save" would be false:
 * it is saved, locally.
 *
 * Nothing local is lost. The server cannot return attempts, so a merge that
 * overwrites deletes the learner's own take history from the one device that
 * had it.
 *
 * A take scored *during* a request is not forgotten. Clearing every flag on
 * success would drop the one set mid-flight, leaving that work sitting locally
 * with nothing marking it unsent.
 *
 * jsdom exposes `localStorage` as a bare object with no methods, so every test
 * installs a real in-memory Storage.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function installStorage(seed?: Record<string, string>): Map<string, string> {
  const data = new Map(Object.entries(seed ?? {}));
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
      key: (i: number) => [...data.keys()][i] ?? null,
      get length() {
        return data.size;
      },
    },
  });
  return data;
}

const LEARNER = "marie";
const TOKEN = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.1757000000000.signature";

/** What the fake server was asked, and what it replies. */
interface Exchange {
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

let exchanges: Exchange[] = [];
let syncReply: { status: number; body: unknown } = { status: 200, body: emptySnapshot() };
let registerReply: { status: number; body: unknown } = { status: 200, body: { token: TOKEN } };
let networkFails = false;

function emptySnapshot() {
  return { progress: [], skills: [], streak: { days: [], longest: 0 } };
}

const fakeFetch: typeof fetch = (input, init) => {
  const url = String(input);
  if (networkFails) return Promise.reject(new TypeError("Failed to fetch"));

  const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
  exchanges.push({ url, body, headers: (init?.headers ?? {}) as Record<string, string> });

  const reply = url.includes("/learners") ? registerReply : syncReply;
  return Promise.resolve(
    new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    }),
  );
};

async function load() {
  vi.resetModules();
  return {
    engine: await import("./engine.js"),
    dirty: await import("./dirty.js"),
  };
}

function syncBody(): { progress?: unknown[]; skills?: unknown[]; streak?: unknown } {
  const call = exchanges.find((e) => e.url.includes("/sync"));
  return (call?.body ?? {}) as { progress?: unknown[]; skills?: unknown[]; streak?: unknown };
}

/** Seeds a scored activity and a practice day, then marks them dirty. */
async function seedPractice(dirty: Awaited<ReturnType<typeof load>>["dirty"]): Promise<void> {
  localStorage.setItem(
    `sonare.progress.v2.fr.${LEARNER}`,
    JSON.stringify({
      index: 1,
      progress: [
        {
          activityId: 1,
          attempts: [{ activityId: 1, result: {}, accuracy: 82, at: "2026-09-07T10:00:00.000Z" }],
          best: 82,
          passed: true,
          skipped: false,
        },
      ],
      finished: false,
    }),
  );
  localStorage.setItem(
    `sonare.skills.v1.fr.${LEARNER}`,
    JSON.stringify({ bon: { grapheme: "bon", samples: [{ at: "2026-09-07T10:00:00.000Z", accuracy: 88 }] } }),
  );
  localStorage.setItem(
    `sonare.streak.v1.${LEARNER}`,
    JSON.stringify({ days: ["2026-09-07"], current: 1, longest: 1 }),
  );
  dirty.markLanguageDirty(LEARNER, "fr");
  dirty.markStreakDirty(LEARNER);
}

beforeEach(() => {
  installStorage();
  exchanges = [];
  networkFails = false;
  syncReply = { status: 200, body: emptySnapshot() };
  registerReply = { status: 200, body: { token: TOKEN } };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("registering on the way in", () => {
  it("gets a token before syncing, and reuses it after", async () => {
    const { engine } = await load();

    await engine.syncNow({ learnerName: LEARNER, fetchImpl: fakeFetch });
    await engine.syncNow({ learnerName: LEARNER, fetchImpl: fakeFetch });

    expect(exchanges.filter((e) => e.url.includes("/learners"))).toHaveLength(1);
    expect(exchanges.filter((e) => e.url.includes("/sync"))).toHaveLength(2);
  });

  it("sends the learner's chosen name so the server's copy has it", async () => {
    const { engine } = await load();

    await engine.syncNow({ learnerName: LEARNER, locale: "fr-FR", fetchImpl: fakeFetch });

    expect(exchanges[0]?.body).toMatchObject({ displayName: LEARNER, locale: "fr-FR" });
  });

  it("omits a name it does not have rather than sending null", async () => {
    // The server treats an absent name as "leave what you have"; a null would
    // be a value, and could clear one the learner set on another device.
    const { engine } = await load();

    await engine.syncNow({ learnerName: null, fetchImpl: fakeFetch });

    expect(exchanges[0]?.body).not.toHaveProperty("displayName");
  });

  it("defers rather than syncing when registration fails", async () => {
    const { engine } = await load();
    registerReply = { status: 503, body: { error: {} } };

    const outcome = await engine.syncNow({ learnerName: LEARNER, fetchImpl: fakeFetch });

    expect(outcome).toEqual({ status: "deferred", reason: "no-token" });
    expect(exchanges.some((e) => e.url.includes("/sync"))).toBe(false);
  });

  it("carries the token as a bearer header, never the bare id", async () => {
    const { engine } = await load();

    await engine.syncNow({ learnerName: LEARNER, fetchImpl: fakeFetch });

    const sync = exchanges.find((e) => e.url.includes("/sync"));
    expect(sync?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
  });
});

describe("pushing what changed, and only that", () => {
  it("sends nothing when nothing is dirty", async () => {
    const { engine } = await load();

    await engine.syncNow({ learnerName: LEARNER, fetchImpl: fakeFetch });

    expect(syncBody()).toEqual({ progress: [], skills: [] });
  });

  it("sends the language that was practised", async () => {
    const { engine, dirty } = await load();
    await seedPractice(dirty);

    await engine.syncNow({ learnerName: LEARNER, fetchImpl: fakeFetch });

    const body = syncBody();
    expect(body.progress).toHaveLength(1);
    expect(body.skills).toHaveLength(1);
    expect(body.streak).toEqual({ days: ["2026-09-07"], longest: 1 });
  });

  it("does not send a language that has not changed", async () => {
    // Each language is a read-modify-write with retries on the server, so
    // pushing an unchanged one spends that for nothing.
    const { engine, dirty } = await load();
    dirty.markLanguageDirty(LEARNER, "fr");

    await engine.syncNow({ learnerName: LEARNER, fetchImpl: fakeFetch });

    expect((syncBody().progress as Array<{ slug: string }>).map((p) => p.slug)).toEqual(["fr"]);
  });

  it("omits the streak entirely when it has not changed", async () => {
    // Rather than sending an empty one, which the server would merge as a
    // union of nothing — harmless, and still a pointless write.
    const { engine, dirty } = await load();
    dirty.markLanguageDirty(LEARNER, "fr");

    await engine.syncNow({ learnerName: LEARNER, fetchImpl: fakeFetch });

    expect(syncBody()).not.toHaveProperty("streak");
  });

  it("pushes nothing at all when asked only to pull", async () => {
    // For a fresh device restoring a record it has no local version of.
    const { engine, dirty } = await load();
    await seedPractice(dirty);

    await engine.syncNow({ learnerName: LEARNER, pullOnly: true, fetchImpl: fakeFetch });

    expect(syncBody()).toEqual({ progress: [], skills: [] });
    // And the flags survive, so the local work is still pushed later.
    expect(dirty.readDirty(LEARNER).progress).toEqual(["fr"]);
  });
});

describe("a failure costs nothing", () => {
  it("keeps the dirty flags when the network is gone", async () => {
    const { engine, dirty } = await load();
    await seedPractice(dirty);
    // A token already in hand, so the failure is the sync itself rather than
    // registration — both defer, and they defer for different reasons.
    localStorage.setItem(`sonare.sync.token.v1.${LEARNER}`, TOKEN);
    networkFails = true;

    const outcome = await engine.syncNow({ learnerName: LEARNER, fetchImpl: fakeFetch });

    expect(outcome).toEqual({ status: "deferred", reason: "network" });
    expect(dirty.readDirty(LEARNER)).toEqual({ progress: ["fr"], skills: ["fr"], streak: true });
  });

  it("keeps them when it cannot even register", async () => {
    // The first-ever sync on a device with no network. Distinguished from a
    // failed push so a caller can tell "never had an identity" from "could
    // not reach the server this time".
    const { engine, dirty } = await load();
    await seedPractice(dirty);
    networkFails = true;

    const outcome = await engine.syncNow({ learnerName: LEARNER, fetchImpl: fakeFetch });

    expect(outcome).toEqual({ status: "deferred", reason: "no-token" });
    expect(dirty.readDirty(LEARNER).streak).toBe(true);
  });

  it("keeps them when the server refuses", async () => {
    const { engine, dirty } = await load();
    await seedPractice(dirty);
    syncReply = { status: 503, body: { error: {} } };

    const outcome = await engine.syncNow({ learnerName: LEARNER, fetchImpl: fakeFetch });

    expect(outcome).toEqual({ status: "deferred", reason: "rejected" });
    expect(dirty.readDirty(LEARNER).streak).toBe(true);
  });

  it("never throws into the caller", async () => {
    /**
     * Every caller reaches this after the local write and the render, on a
     * path where the learner is doing something else. An escaping rejection
     * would surface as an unhandled error on a screen that is working.
     */
    const { engine } = await load();
    networkFails = true;

    await expect(engine.syncNow({ learnerName: LEARNER, fetchImpl: fakeFetch })).resolves.toBeDefined();
  });

  it("leaves the local record untouched on a failure", async () => {
    const { engine, dirty } = await load();
    await seedPractice(dirty);
    const before = localStorage.getItem(`sonare.progress.v2.fr.${LEARNER}`);
    networkFails = true;

    await engine.syncNow({ learnerName: LEARNER, fetchImpl: fakeFetch });

    expect(localStorage.getItem(`sonare.progress.v2.fr.${LEARNER}`)).toBe(before);
  });

  it("drops a token the server no longer accepts, so the next try registers", async () => {
    // Retrying a credential that cannot work would defer forever. Registering
    // again is cheap and returns the same learner.
    const { engine } = await load();
    syncReply = { status: 401, body: { error: {} } };

    const outcome = await engine.syncNow({ learnerName: LEARNER, fetchImpl: fakeFetch });

    expect(outcome).toEqual({ status: "deferred", reason: "rejected" });
    expect(localStorage.getItem(`sonare.sync.token.v1.${LEARNER}`)).toBeNull();
  });
});

describe("a reply that is not a snapshot", () => {
  it("is refused rather than written over the local record", async () => {
    /**
     * A captive portal, a proxy or a stale service worker can all return
     * something shaped like JSON. Writing it would replace a learner's record
     * with a login page.
     */
    const { engine, dirty } = await load();
    await seedPractice(dirty);
    syncReply = { status: 200, body: { message: "please sign in to the wifi" } };

    const outcome = await engine.syncNow({ learnerName: LEARNER, fetchImpl: fakeFetch });

    expect(outcome).toEqual({ status: "deferred", reason: "bad-response" });
    const stored = JSON.parse(localStorage.getItem(`sonare.progress.v2.fr.${LEARNER}`) as string) as {
      progress: unknown[];
    };
    expect(stored.progress).toHaveLength(1);
  });

  it("keeps the dirty flags, so the work is pushed again", async () => {
    const { engine, dirty } = await load();
    await seedPractice(dirty);
    syncReply = { status: 200, body: "not even an object" };

    await engine.syncNow({ learnerName: LEARNER, fetchImpl: fakeFetch });

    expect(dirty.readDirty(LEARNER).progress).toEqual(["fr"]);
  });
});

describe("folding the reply back in", () => {
  it("restores a record this device has never had", async () => {
    /**
     * The journey the whole feature exists for: clear site data, reload, and
     * find your own streak and progress again.
     */
    const { engine } = await load();
    syncReply = {
      status: 200,
      body: {
        progress: [
          {
            slug: "fr",
            entries: [
              {
                activityId: 4,
                passed: true,
                bestAccuracy: 91,
                attemptsUsed: 2,
                skipped: false,
                at: "2026-09-06T10:00:00.000Z",
              },
            ],
          },
        ],
        skills: [{ slug: "fr", skills: [{ grapheme: "ment", samples: [{ at: "2026-09-06T10:00:00.000Z", accuracy: 61 }] }] }],
        streak: { days: ["2026-09-05", "2026-09-06"], longest: 2 },
      },
    };

    const outcome = await engine.syncNow({ learnerName: LEARNER, fetchImpl: fakeFetch });

    expect(outcome.status).toBe("synced");
    const progress = JSON.parse(localStorage.getItem(`sonare.progress.v2.fr.${LEARNER}`) as string) as {
      progress: Array<{ activityId: number; passed: boolean }>;
    };
    expect(progress.progress[0]).toMatchObject({ activityId: 4, passed: true });
    const streak = JSON.parse(localStorage.getItem(`sonare.streak.v1.${LEARNER}`) as string) as {
      days: string[];
      current: number;
    };
    expect(streak.days).toEqual(["2026-09-05", "2026-09-06"]);
  });

  it("keeps the local attempts when the server sends a summary", async () => {
    // The server has no copy of them; anything but keeping them deletes the
    // learner's own take history from the device that recorded it.
    const { engine, dirty } = await load();
    await seedPractice(dirty);
    syncReply = {
      status: 200,
      body: {
        progress: [
          {
            slug: "fr",
            entries: [
              { activityId: 1, passed: true, bestAccuracy: 82, attemptsUsed: 1, skipped: false, at: "2026-09-07T10:00:00.000Z" },
            ],
          },
        ],
        skills: [],
        streak: { days: [], longest: 0 },
      },
    };

    await engine.syncNow({ learnerName: LEARNER, fetchImpl: fakeFetch });

    const stored = JSON.parse(localStorage.getItem(`sonare.progress.v2.fr.${LEARNER}`) as string) as {
      progress: Array<{ attempts: unknown[] }>;
    };
    expect(stored.progress[0]?.attempts).toHaveLength(1);
  });

  it("does not move where this device left off", async () => {
    const { engine, dirty } = await load();
    await seedPractice(dirty);
    syncReply = {
      status: 200,
      body: {
        progress: [{ slug: "fr", entries: [{ activityId: 9, passed: true, bestAccuracy: 90, attemptsUsed: 1, skipped: false, at: "2026-09-06T10:00:00.000Z" }] }],
        skills: [],
        streak: { days: [], longest: 0 },
      },
    };

    await engine.syncNow({ learnerName: LEARNER, fetchImpl: fakeFetch });

    const stored = JSON.parse(localStorage.getItem(`sonare.progress.v2.fr.${LEARNER}`) as string) as {
      index: number;
    };
    expect(stored.index).toBe(1);
  });

  it("clears the flags it pushed", async () => {
    const { engine, dirty } = await load();
    await seedPractice(dirty);

    await engine.syncNow({ learnerName: LEARNER, fetchImpl: fakeFetch });

    expect(dirty.readDirty(LEARNER)).toEqual({ progress: [], skills: [], streak: false });
  });

  it("does not clear a flag set while the request was in flight", async () => {
    /**
     * A take scored during the push. Clearing everything on success would
     * drop its flag, and the work would sit locally forever with nothing
     * marking it unsent — the kind of loss that only shows up as a learner
     * insisting they did something the server has never heard of.
     */
    const { engine, dirty } = await load();
    dirty.markLanguageDirty(LEARNER, "fr");

    const midFlight: typeof fetch = (input, init) => {
      if (String(input).includes("/sync")) dirty.markLanguageDirty(LEARNER, "es");
      return fakeFetch(input, init);
    };

    await engine.syncNow({ learnerName: LEARNER, fetchImpl: midFlight });

    expect(dirty.readDirty(LEARNER)).toEqual({ progress: ["es"], skills: ["es"], streak: false });
  });

  it("reports nothing-to-do when both sides are empty", async () => {
    // So a caller can tell a real sync from a heartbeat, and not log one.
    const { engine } = await load();

    expect(await engine.syncNow({ learnerName: LEARNER, fetchImpl: fakeFetch })).toEqual({
      status: "nothing-to-do",
    });
  });
});

describe("when storage will not cooperate", () => {
  it("still syncs, and still does not throw", async () => {
    const { engine } = await load();
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });

    await expect(engine.syncNow({ learnerName: LEARNER, fetchImpl: fakeFetch })).resolves.toBeDefined();
  });
});

describe("a shared device", () => {
  it("registers each named learner separately", async () => {
    /**
     * The bug this guards. Identity used to be one id and one token per
     * *browser* while every local store keyed on the learner's name — so two
     * learners on a classroom tablet were pushed to the server under the same
     * identity and the server merged them. Shared streak days, sound
     * histories pooled across two different accents, and activities showing
     * as passed that the other person never attempted.
     */
    const { engine } = await load();

    await engine.syncNow({ learnerName: "marie", fetchImpl: fakeFetch });
    await engine.syncNow({ learnerName: "ahmed", fetchImpl: fakeFetch });

    const registrations = exchanges.filter((e) => e.url.includes("/learners"));
    expect(registrations).toHaveLength(2);

    const ids = registrations.map((e) => (e.body as { learnerId: string }).learnerId);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("does not reuse one learner's token for another", async () => {
    // A single token per browser would defeat the per-learner id entirely:
    // the second learner would present the first one's credential and be
    // merged straight back into their record.
    const { engine } = await load();
    await engine.syncNow({ learnerName: "marie", fetchImpl: fakeFetch });
    exchanges.length = 0;

    await engine.syncNow({ learnerName: "ahmed", fetchImpl: fakeFetch });

    expect(exchanges.some((e) => e.url.includes("/learners"))).toBe(true);
  });

  it("keeps dirty work attributed to the learner who did it", async () => {
    const { engine, dirty } = await load();
    dirty.markLanguageDirty("marie", "fr");

    await engine.syncNow({ learnerName: "ahmed", fetchImpl: fakeFetch });

    // Ahmed's sync carries nothing of Marie's, and Marie's flag survives.
    expect(syncBody()).toEqual({ progress: [], skills: [] });
    expect(dirty.readDirty("marie").progress).toEqual(["fr"]);
  });
});
