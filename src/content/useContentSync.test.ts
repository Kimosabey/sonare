// @vitest-environment jsdom

/**
 * Fetching published content into the cache.
 *
 * The contract is that nothing waits on it and nothing breaks when it fails.
 * A 404 means nothing is published and the bundle is correct; a network error
 * means offline; a malformed body means a set not worth trusting. All three
 * have the same right answer — keep using what we have — so the interesting
 * assertions are all about *not* changing anything.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, cleanup, waitFor } from "@testing-library/react";
import { useContentSync } from "./useContentSync.js";
import { resolveLanguage, servedVersions } from "./resolve.js";
import { LANGUAGES } from "../activities/languages/index.js";

function installStorage(): void {
  const data = new Map<string, string>();
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

function first() {
  const found = LANGUAGES[0];
  if (found === undefined) throw new Error("no languages configured");
  return found;
}

const FIRST = first();

/** What the fake server returns for each slug. */
let replies: Record<string, { status: number; body: unknown }> = {};
let requested: string[] = [];
let networkFails = false;

const fakeFetch: typeof fetch = (input) => {
  const url = String(input);
  const slug = url.split("/").pop() ?? "";
  requested.push(slug);

  if (networkFails) return Promise.reject(new TypeError("Failed to fetch"));

  const reply = replies[slug] ?? { status: 404, body: { error: {} } };
  return Promise.resolve(
    new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    }),
  );
};

function servedSet(over: Record<string, unknown> = {}) {
  return {
    slug: FIRST.slug,
    code: FIRST.code,
    label: FIRST.label,
    version: 2,
    activities: [
      {
        id: 1,
        title: "Served greeting",
        kind: "repeat",
        prompt: "Say this served phrase",
        gloss: "hello",
        target: "Bonsoir",
        focus: "the served focus",
      },
    ],
    ...over,
  };
}

function run(onDone?: (updated: string[]) => void) {
  return renderHook(() => useContentSync({ fetchImpl: fakeFetch, ...(onDone ? { onDone } : {}) }));
}

beforeEach(() => {
  installStorage();
  replies = {};
  requested = [];
  networkFails = false;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("fetching", () => {
  it("asks for every bundled language", async () => {
    // All at once: independent documents on an endpoint that does no work, so
    // sequential round trips would take four times as long to reach the same
    // place.
    const done = vi.fn();
    run(done);

    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(requested.sort()).toEqual(LANGUAGES.map((l) => l.slug).sort());
  });

  it("caches a published set so the resolver serves it", async () => {
    replies[FIRST.slug] = { status: 200, body: servedSet() };
    const done = vi.fn();
    run(done);

    await waitFor(() => expect(done).toHaveBeenCalledWith([FIRST.slug]));
    expect(resolveLanguage(FIRST.slug)?.activities[0]?.target).toBe("Bonsoir");
  });

  it("fetches once, not on every render", async () => {
    // Content changes when somebody publishes, which is rare; a learner
    // re-renders constantly.
    const done = vi.fn();
    const { rerender } = run(done);

    await waitFor(() => expect(done).toHaveBeenCalled());
    rerender();
    rerender();

    expect(requested).toHaveLength(LANGUAGES.length);
  });
});

describe("when nothing changes the cache", () => {
  it("leaves the bundle in place on a 404", async () => {
    // The normal answer for an unpublished language, not an error.
    const done = vi.fn();
    run(done);

    await waitFor(() => expect(done).toHaveBeenCalledWith([]));
    expect(resolveLanguage(FIRST.slug)?.activities[0]?.target).toBe(FIRST.activities[0]?.target);
  });

  it("leaves it in place when the network is gone", async () => {
    networkFails = true;
    const done = vi.fn();
    run(done);

    await waitFor(() => expect(done).toHaveBeenCalledWith([]));
    expect(servedVersions()).toEqual({});
  });

  it("leaves it in place on a malformed body", async () => {
    replies[FIRST.slug] = { status: 200, body: { message: "please sign in to the wifi" } };
    const done = vi.fn();
    run(done);

    await waitFor(() => expect(done).toHaveBeenCalledWith([]));
    expect(resolveLanguage(FIRST.slug)?.activities[0]?.target).toBe(FIRST.activities[0]?.target);
  });

  it("refuses a body answering for a different language", async () => {
    /**
     * A misrouted or cached-wrong response must not overwrite the set that
     * was asked for — that would silently give a learner French phrases under
     * a Spanish heading.
     */
    replies[FIRST.slug] = { status: 200, body: servedSet({ slug: LANGUAGES[1]?.slug ?? "es" }) };
    const done = vi.fn();
    run(done);

    await waitFor(() => expect(done).toHaveBeenCalledWith([]));
    expect(servedVersions()).toEqual({});
  });

  it("refuses a set with no usable activities", async () => {
    replies[FIRST.slug] = { status: 200, body: servedSet({ activities: [] }) };
    const done = vi.fn();
    run(done);

    await waitFor(() => expect(done).toHaveBeenCalledWith([]));
    expect(resolveLanguage(FIRST.slug)?.activities.length).toBe(FIRST.activities.length);
  });

  it("takes the languages that succeeded when one fails", async () => {
    // Independent fetches, so one failure must not cost the others.
    replies[FIRST.slug] = { status: 200, body: servedSet() };
    replies[LANGUAGES[1]?.slug ?? "es"] = { status: 500, body: {} };
    const done = vi.fn();
    run(done);

    await waitFor(() => expect(done).toHaveBeenCalledWith([FIRST.slug]));
  });
});

describe("never in the way", () => {
  it("does not throw when storage is blocked", async () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    replies[FIRST.slug] = { status: 200, body: servedSet() };
    const done = vi.fn();

    expect(() => run(done)).not.toThrow();
    await waitFor(() => expect(done).toHaveBeenCalled());
  });

  it("does not call back after unmounting", async () => {
    // The cache writes already happened; this only stops a callback firing
    // into a component that has gone.
    const done = vi.fn();
    const { unmount } = run(done);
    unmount();

    await new Promise((r) => setTimeout(r, 20));
    expect(done).not.toHaveBeenCalled();
  });
});
