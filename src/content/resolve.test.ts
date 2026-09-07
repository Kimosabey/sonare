// @vitest-environment jsdom

/**
 * Served content over the bundle, and the bundle whenever served content
 * cannot be trusted.
 *
 * The bundle is the floor, not a legacy path. Every failure here — nothing
 * published, a malformed set, blocked storage, a language with no activities —
 * has the same right answer: use what the app shipped with. Getting any of
 * them wrong replaces a working language with an empty one, and an empty
 * language reads to a learner as a broken app rather than as missing content.
 *
 * jsdom exposes `localStorage` as a bare object with no methods, so every test
 * installs a real in-memory Storage.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCache, readCachedSet, writeCachedSet, type CachedSet } from "./cache.js";
import { resolveLanguage, resolveLanguages, servedVersions } from "./resolve.js";
import { LANGUAGES } from "../activities/languages/index.js";

function installStorage(seed?: Record<string, string>): void {
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
}

const KEY = "sonare.content.v1";

function first() {
  const found = LANGUAGES[0];
  if (found === undefined) throw new Error("no languages configured");
  return found;
}

const FIRST = first();

function activity(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    title: "Served greeting",
    kind: "repeat",
    prompt: "Say this served phrase",
    gloss: "hello",
    target: "Bonsoir",
    focus: "the served focus",
    ...over,
  };
}

function served(over: Record<string, unknown> = {}): CachedSet {
  return {
    slug: FIRST.slug,
    code: FIRST.code,
    label: FIRST.label,
    version: 2,
    activities: [activity()],
    ...over,
  } as CachedSet;
}

/** Puts a set straight into storage, as a previous fetch would have. */
function cache(...sets: unknown[]): void {
  installStorage({
    [KEY]: JSON.stringify(Object.fromEntries(sets.map((s) => [(s as CachedSet).slug, s]))),
  });
}

beforeEach(() => {
  installStorage();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("with nothing served", () => {
  it("uses the bundled set", () => {
    expect(resolveLanguage(FIRST.slug)?.activities[0]?.target).toBe(FIRST.activities[0]?.target);
  });

  it("lists every bundled language", () => {
    expect(resolveLanguages().map((l) => l.slug)).toEqual(LANGUAGES.map((l) => l.slug));
  });

  it("reports nothing as served", () => {
    expect(servedVersions()).toEqual({});
  });
});

describe("with content served", () => {
  it("prefers the served phrases", () => {
    // The whole point: a phrase corrected by publishing rather than shipping.
    cache(served());

    expect(resolveLanguage(FIRST.slug)?.activities[0]?.target).toBe("Bonsoir");
  });

  it("falls back per language, not all or nothing", () => {
    /**
     * French having a published set does not mean Spanish must. A learner who
     * has fetched one should not lose the other three.
     */
    cache(served());
    const resolved = resolveLanguages();

    expect(resolved[0]?.activities[0]?.target).toBe("Bonsoir");
    expect(resolved[1]?.activities[0]?.target).toBe(LANGUAGES[1]?.activities[0]?.target);
  });

  it("keeps the bundle's display order", () => {
    // A learner should not see the picker rearrange itself because a fetch
    // completed.
    cache(served({ slug: LANGUAGES[2]?.slug ?? "de", label: "Third" }));

    expect(resolveLanguages().map((l) => l.slug)).toEqual(LANGUAGES.map((l) => l.slug));
  });

  it("reports which languages are served, and at what version", () => {
    cache(served({ version: 7 }));

    expect(servedVersions()).toEqual({ [FIRST.slug]: 7 });
  });

  it("ignores a language the bundle has never heard of", () => {
    /**
     * A new language needs routing, a picker entry and a locale the capture
     * layer supports — none of which arrive with a content document. Content
     * may correct and extend what ships; it may not introduce a language the
     * rest of the app has no idea how to handle.
     */
    cache(served({ slug: "zz" }));

    expect(resolveLanguage("zz")).toBeUndefined();
    expect(resolveLanguages().map((l) => l.slug)).toEqual(LANGUAGES.map((l) => l.slug));
    expect(servedVersions()).toEqual({});
  });

  it("does not let a corrupt key make one language masquerade as another", () => {
    // Keyed by the set's own slug on read, not by the object key.
    installStorage({ [KEY]: JSON.stringify({ [LANGUAGES[1]?.slug ?? "es"]: served() }) });

    expect(resolveLanguage(FIRST.slug)?.activities[0]?.target).toBe("Bonsoir");
    expect(resolveLanguage(LANGUAGES[1]?.slug)?.activities[0]?.target).toBe(
      LANGUAGES[1]?.activities[0]?.target,
    );
  });
});

describe("refusing what it cannot use", () => {
  it("falls back on a set with no activities", () => {
    /**
     * The failure that matters. An empty language reads as a broken app, and
     * caching one would replace a working bundled set with nothing.
     */
    cache(served({ activities: [] }));

    expect(resolveLanguage(FIRST.slug)?.activities.length).toBe(FIRST.activities.length);
  });

  it("falls back on an activity with nothing to say aloud", () => {
    // A missing target means scoring speech against nothing.
    cache(served({ activities: [activity({ target: "" })] }));

    expect(resolveLanguage(FIRST.slug)?.activities[0]?.target).toBe(FIRST.activities[0]?.target);
  });

  it("falls back on an activity with no instruction", () => {
    cache(served({ activities: [activity({ prompt: "" })] }));

    expect(resolveLanguage(FIRST.slug)?.activities[0]?.target).toBe(FIRST.activities[0]?.target);
  });

  it("refuses an activity kind the app cannot render", () => {
    // The union is `repeat | respond | read`; anything else would reach a
    // switch with no branch for it.
    expect(readCachedSet(served({ activities: [activity({ kind: "sing" })] }))).toBeNull();
  });

  it("keeps the good activities in a set with one bad one", () => {
    cache(served({ activities: [activity({ id: 1 }), activity({ id: 2, target: "" }), activity({ id: 3 })] }));

    expect(resolveLanguage(FIRST.slug)?.activities.map((a) => a.id)).toEqual([1, 3]);
  });

  it.each([
    ["no version", { version: undefined }],
    ["version zero", { version: 0 }],
    ["a fractional version", { version: 1.5 }],
    ["no code", { code: "" }],
    ["no label", { label: "" }],
    ["a bad slug", { slug: "../etc" }],
  ])("falls back on %s", (_label, over) => {
    cache(served(over));

    expect(resolveLanguage(FIRST.slug)?.activities[0]?.target).toBe(FIRST.activities[0]?.target);
  });

  it("falls back on a corrupt cache", () => {
    installStorage({ [KEY]: "{not json" });

    expect(resolveLanguage(FIRST.slug)?.activities[0]?.target).toBe(FIRST.activities[0]?.target);
  });

  it("falls back when storage refuses", () => {
    /**
     * Blocked storage must not mean a blank app. This runs on every screen, so
     * an escaping error here would be a white page.
     */
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });

    expect(() => resolveLanguages()).not.toThrow();
    expect(resolveLanguage(FIRST.slug)?.activities.length).toBe(FIRST.activities.length);
  });

  it("ignores a cache from an older schema", () => {
    installStorage({ "sonare.content.v0": JSON.stringify({ [FIRST.slug]: served() }) });

    expect(resolveLanguage(FIRST.slug)?.activities[0]?.target).toBe(FIRST.activities[0]?.target);
  });
});

describe("writing the cache", () => {
  it("stores a set and reads it back", () => {
    writeCachedSet(served());

    expect(resolveLanguage(FIRST.slug)?.activities[0]?.target).toBe("Bonsoir");
  });

  it("does not evict the languages already cached", () => {
    /**
     * The four languages are fetched independently, so a failure on one must
     * not evict the three that succeeded.
     */
    writeCachedSet(served());
    writeCachedSet(served({ slug: LANGUAGES[1]?.slug ?? "es", label: "Second", version: 3 }));

    expect(Object.keys(servedVersions()).sort()).toEqual(
      [FIRST.slug, LANGUAGES[1]?.slug ?? "es"].sort(),
    );
  });

  it("never throws when storage is full", () => {
    // This runs right after a fetch, on a path the learner is not waiting on.
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });

    expect(() => writeCachedSet(served())).not.toThrow();
  });

  it("clears, for a reset", () => {
    writeCachedSet(served());

    clearCache();

    expect(servedVersions()).toEqual({});
    expect(resolveLanguage(FIRST.slug)?.activities[0]?.target).toBe(FIRST.activities[0]?.target);
  });
});
