// @vitest-environment jsdom

/**
 * Fetching published content into the cache.
 *
 * The contract is that nothing waits on it and nothing breaks when it fails.
 * A 204 means nothing is published and the bundle is correct; a 404 means the
 * same from a server that predates the 204; a network error means offline; a
 * malformed body means a set not worth trusting. All four have the same right
 * answer — keep using what we have — so the interesting assertions are all
 * about *not* changing anything.
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
/**
 * Slugs whose response body the client tried to read.
 *
 * Needed because every failure in this hook converges on the same silent
 * outcome, so "did it parse a 204" is invisible from the callback — a parse
 * that throws is caught and reports exactly what a skipped parse reports.
 * Recording the attempt is the only way the assertion can fail.
 */
let parsed: string[] = [];
let networkFails = false;

const fakeFetch: typeof fetch = (input) => {
  const url = String(input);
  const slug = url.split("/").pop() ?? "";
  requested.push(slug);

  if (networkFails) return Promise.reject(new TypeError("Failed to fetch"));

  const reply = replies[slug] ?? { status: 204, body: null };
  /**
   * A 204 carries no body, and that is the point of the case rather than a
   * detail: `Response` refuses a body with a 204 status, exactly as a browser
   * does, so a client that parses before checking the status throws here the
   * same way it would in the wild.
   *
   * The default is 204 rather than 404 because nothing-published is the
   * ordinary state of a fresh deployment — see server/routes/content.ts.
   */
  if (reply.status === 204) {
    const response = new Response(null, { status: 204 });
    const json = response.json.bind(response);
    response.json = () => {
      parsed.push(slug);
      return json();
    };
    return Promise.resolve(response);
  }
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
  parsed = [];
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
  it("leaves the bundle in place when nothing is published", async () => {
    // A 204, which is the ordinary state of a deployment nobody has published
    // to yet — not an error, and the fake server's default for that reason.
    const done = vi.fn();
    run(done);

    await waitFor(() => expect(done).toHaveBeenCalledWith([]));
    expect(resolveLanguage(FIRST.slug)?.activities[0]?.target).toBe(FIRST.activities[0]?.target);
  });

  it("does not read the body of a 204", async () => {
    /**
     * A 204 carries none, so reading it throws — and the throw would be caught
     * and reported as the same silent nothing, which is why this is asserted
     * rather than left to the outcome. The cost of getting it wrong is the
     * ordinary case running through the error path on every load.
     */
    const done = vi.fn();
    run(done);

    await waitFor(() => expect(done).toHaveBeenCalledWith([]));
    expect(parsed).toEqual([]);
  });

  it("leaves it in place on a 404, for a server that predates the 204", async () => {
    // Older deployments answer this way and mean the same thing.
    replies[FIRST.slug] = { status: 404, body: { error: { code: "not_found" } } };
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
