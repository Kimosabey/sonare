// @vitest-environment jsdom

/**
 * What a learner's classes have suggested, if any.
 *
 * Every property here is a refusal to be the reason Today does not render. A
 * class suggestion is an *extra* prompt: a learner who is offline, in no
 * class, or whose server is down should see exactly the screen they would
 * have seen anyway. That makes "fails quietly" the feature rather than a
 * shortcut — and it also makes every failure invisible, which is why it needs
 * testing rather than trusting.
 */

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSuggestedSittings, type SuggestedSitting } from "./useSuggestedSittings.js";
import { saveToken, clearToken } from "../sync/tokenStore.js";

const LEARNER = "Maya";

function installStorage(): void {
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return map.size;
      },
      clear: () => map.clear(),
      getItem: (k: string) => map.get(k) ?? null,
      key: (i: number) => [...map.keys()][i] ?? null,
      removeItem: (k: string) => void map.delete(k),
      setItem: (k: string, v: string) => void map.set(k, String(v)),
    },
  });
}

let seen: SuggestedSitting[] = [];
let calls: { url: string; headers: Record<string, string> }[] = [];

function Harness({ learner = LEARNER as string | null }) {
  seen = useSuggestedSittings(learner);
  return null;
}

function stub(status: number, body: unknown, throws = false): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), headers: (init.headers ?? {}) as Record<string, string> });
      if (throws) throw new TypeError("Failed to fetch");
      return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
    }),
  );
}

const good: SuggestedSitting = {
  classId: "c-1",
  className: "Year 9 French",
  teacherName: "Mr Okonjo",
  slug: "fr",
  lessonId: 3,
  window: "this week",
};

beforeEach(() => {
  vi.clearAllMocks();
  seen = [];
  calls = [];
  installStorage();
  saveToken(LEARNER, "a.b.c");
});

afterEach(() => {
  clearToken(LEARNER);
  cleanup();
});

describe("when there is something to suggest", () => {
  it("returns it, carrying the learner's own token", async () => {
    stub(200, { suggestions: [good] });
    render(<Harness />);

    await waitFor(() => {
      expect(seen).toEqual([good]);
    });
    expect(calls[0]?.headers.authorization).toBe("Bearer a.b.c");
  });
});

describe("when there is not", () => {
  /**
   * No credential means no class, because joining one is what mints it. The
   * request is skipped entirely rather than sent and refused — a 401 per
   * learner per visit is noise in a log that somebody has to read.
   */
  it("asks nothing at all when this device has no token", async () => {
    clearToken(LEARNER);
    stub(200, { suggestions: [good] });

    render(<Harness />);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(calls).toEqual([]);
    expect(seen).toEqual([]);
  });

  it.each([
    ["a failure status", 500, {}],
    ["a body with no list", 200, { suggestions: "all of them" }],
    ["a body that is not an object", 200, "nonsense"],
  ])("suggests nothing for %s", async (_label, status, body) => {
    stub(status, body);
    render(<Harness />);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toEqual([]);
  });

  it("suggests nothing when the device is offline", async () => {
    stub(0, {}, true);
    render(<Harness />);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toEqual([]);
  });
});

describe("reading what the server sent", () => {
  /**
   * Half-formed rows are dropped one at a time, and the rest survive. A
   * suggestion missing its teacher would render as a prompt from nobody; a
   * suggestion missing its lesson would be a prompt to practise nothing.
   */
  it("keeps the rows it can read and drops the ones it cannot", async () => {
    stub(200, {
      suggestions: [
        good,
        { classId: "c-2" },
        { ...good, classId: "c-3", lessonId: "three" },
        { ...good, classId: "c-4" },
      ],
    });
    render(<Harness />);

    await waitFor(() => {
      expect(seen.map((s) => s.classId)).toEqual(["c-1", "c-4"]);
    });
  });

  /**
   * Including nulls. `typeof null.classId` is a TypeError, and this hook's
   * whole posture is that a failure here is silent — so one null row would
   * take every suggestion with it and nothing would say why.
   */
  it("survives a null in the list without losing the rest", async () => {
    stub(200, { suggestions: [good, null, { ...good, classId: "c-5" }] });
    render(<Harness />);

    await waitFor(() => {
      expect(seen.map((s) => s.classId)).toEqual(["c-1", "c-5"]);
    });
  });
});
