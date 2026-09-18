// @vitest-environment jsdom

/**
 * The client half of belonging to a class — and, mostly, of leaving one.
 *
 * `previewClass` and `joinClass` are driven end to end by
 * `src/components/JoinClassFlow.test.tsx`, which reads the actual requests.
 * This file is about the three that nothing exercised at all: the two exits a
 * pupil is promised, and the list that decides whether the panel offering them
 * appears.
 *
 * The join screen makes a specific promise, in these words:
 *
 * > You can leave the class at any time, and remove your name without leaving.
 *
 * Both halves of that are a network call that can fail, and what a function
 * returns when it fails is the whole difference between a promise kept and a
 * pupil told the opposite of the truth. `removeMyName`'s own header says it
 * must not be optimistic for exactly that reason. Nothing checked that it
 * isn't.
 *
 * The asymmetry between these functions is deliberate and is the other subject
 * here. `myClasses` swallows every failure and returns an empty list, because
 * an empty list is the ordinary answer — most learners are in no class — and
 * the panel simply not appearing is what a learner in no class already sees.
 * The two exits do the reverse and report failure honestly. Being wrong in the
 * lenient direction costs a panel; being wrong in the strict direction costs a
 * child's name.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leaveClass, myClasses, removeMyName, type MyClass } from "./classLink.js";
import { saveToken, clearToken } from "./tokenStore.js";

const LEARNER = "Maya";
const CLASS_ID = "c-9f2a";

/** jsdom exposes `localStorage` as a bare object with no methods. */
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

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/** A fetch that records what it was asked and answers with a fixed status. */
function stub(status: number, body: unknown = {}): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: String(init.method ?? "GET"),
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** A fetch that is offline. */
const offline = (async () => {
  throw new TypeError("Failed to fetch");
}) as unknown as typeof fetch;

/**
 * A fetch that records whether it was reached at all.
 *
 * Not one that throws, which is what this file used first and which proved
 * nothing: every function here catches its own failures and answers falsy, so
 * a throwing stub returns exactly the same result whether the request was
 * skipped or made and failed. A mutant that dropped the token guard entirely
 * survived on that. Counting is the only thing that separates them.
 */
function counted(): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: String(init.method ?? "GET"),
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    return { ok: true, status: 200, json: async () => ({ classes: [] }) } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

beforeEach(() => {
  installStorage();
  saveToken(LEARNER, "a.b.c");
});

afterEach(() => {
  clearToken(LEARNER);
});

describe("removing your name without leaving", () => {
  it("says it worked only when the server says so", async () => {
    const { impl, calls } = stub(200);

    expect(await removeMyName(CLASS_ID, LEARNER, { fetchImpl: impl })).toBe(true);
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toContain(`/classes/${CLASS_ID}/name`);
  });

  /**
   * The one the header insists on. A pupil told their name is gone when it is
   * still on a teacher's screen has been told the opposite of the truth about
   * a thing they asked for — which is worse than an error, because they will
   * not ask again.
   */
  it.each([400, 401, 403, 404, 409, 500, 503])("reports failure on %i", async (status) => {
    const { impl } = stub(status);

    expect(await removeMyName(CLASS_ID, LEARNER, { fetchImpl: impl })).toBe(false);
  });

  it("reports failure when the device is offline", async () => {
    expect(await removeMyName(CLASS_ID, LEARNER, { fetchImpl: offline })).toBe(false);
  });

  /**
   * And it never asks unauthenticated. Without a token the server could only
   * refuse, and the attempt would be a request that says which class this
   * device is interested in while proving nothing about who is asking.
   */
  it("makes no request at all when this device has no token", async () => {
    clearToken(LEARNER);
    const { impl, calls } = counted();

    expect(await removeMyName(CLASS_ID, LEARNER, { fetchImpl: impl })).toBe(false);
    expect(calls).toEqual([]);
  });

  it("carries the learner's own token, not another's", async () => {
    saveToken("ahmed", "x.y.z");
    const { impl, calls } = stub(200);

    await removeMyName(CLASS_ID, LEARNER, { fetchImpl: impl });

    expect(calls[0]?.headers.authorization).toBe("Bearer a.b.c");
    clearToken("ahmed");
  });

  /**
   * A class id is interpolated into the path, so it is escaped. Without this a
   * crafted id containing a slash addresses a different endpoint entirely —
   * and this one is a DELETE.
   */
  it("escapes the class id rather than letting it shape the path", async () => {
    const { impl, calls } = stub(200);

    await removeMyName("../../learners/me", LEARNER, { fetchImpl: impl });

    expect(calls[0]?.url).not.toContain("../../learners/me");
    expect(calls[0]?.url).toContain(encodeURIComponent("../../learners/me"));
  });
});

describe("leaving a class", () => {
  it("says it worked only when the server says so", async () => {
    const { impl, calls } = stub(200);

    expect(await leaveClass(CLASS_ID, LEARNER, { fetchImpl: impl })).toBe(true);
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toContain(`/classes/${CLASS_ID}/membership`);
  });

  it.each([401, 404, 500])("reports failure on %i rather than assuming", async (status) => {
    const { impl } = stub(status);

    expect(await leaveClass(CLASS_ID, LEARNER, { fetchImpl: impl })).toBe(false);
  });

  it("reports failure when the device is offline", async () => {
    expect(await leaveClass(CLASS_ID, LEARNER, { fetchImpl: offline })).toBe(false);
  });

  it("makes no request at all when this device has no token", async () => {
    clearToken(LEARNER);
    const { impl, calls } = counted();

    expect(await leaveClass(CLASS_ID, LEARNER, { fetchImpl: impl })).toBe(false);
    expect(calls).toEqual([]);
  });

  /**
   * Leaving is a different endpoint from removing a name, and the difference
   * is the whole of the promise: one keeps the membership, the other ends it.
   * A test that only checked "a DELETE happened" would pass with them swapped,
   * which would make "remove your name without leaving" false in the most
   * damaging possible way.
   */
  it("ends the membership rather than only the name", async () => {
    const { impl, calls } = stub(200);

    await leaveClass(CLASS_ID, LEARNER, { fetchImpl: impl });

    expect(calls[0]?.url).toContain("/membership");
    expect(calls[0]?.url).not.toContain("/name");
  });
});

describe("the classes this device is in", () => {
  const usable: MyClass = {
    classId: CLASS_ID,
    className: "Year 9 French",
    teacherName: "Mr Okonjo",
    slug: "fr",
    joinedAt: "2026-09-15",
    sharedName: "Maya",
  };

  it("returns what the server listed", async () => {
    const { impl } = stub(200, { classes: [usable] });

    expect(await myClasses(LEARNER, { fetchImpl: impl })).toEqual([usable]);
  });

  /**
   * Lenient in one direction only, and per row. One malformed entry must not
   * hide the classes beside it — a pupil would see a panel missing a class
   * they are in, with nothing to say why.
   */
  it("keeps the rows it can read and drops the ones it cannot", async () => {
    const { impl } = stub(200, {
      classes: [usable, { classId: "c-2" }, null, "nonsense", { ...usable, classId: "c-3" }],
    });

    const result = await myClasses(LEARNER, { fetchImpl: impl });

    expect(result.map((c) => c.classId)).toEqual([CLASS_ID, "c-3"]);
  });

  /**
   * A name this device never shared must never come back as one it did. The
   * membership panel offers "remove my name" against this field, so a
   * fabricated value offers to remove something that was never there.
   */
  it("treats a name that is not a string as no name at all", async () => {
    const { impl } = stub(200, {
      classes: [{ ...usable, sharedName: 42 }, { ...usable, classId: "c-3", sharedName: undefined }],
    });

    const result = await myClasses(LEARNER, { fetchImpl: impl });

    expect(result.map((c) => c.sharedName)).toEqual([null, null]);
  });

  it.each([
    ["a failure status", 500, {}],
    ["a body that is not an object", 200, "nonsense"],
    ["a body with no list", 200, { classes: "all of them" }],
  ])("answers with no classes for %s", async (_label, status, body) => {
    const { impl } = stub(status, body);

    expect(await myClasses(LEARNER, { fetchImpl: impl })).toEqual([]);
  });

  it("answers with no classes when offline, rather than an error to render", async () => {
    expect(await myClasses(LEARNER, { fetchImpl: offline })).toEqual([]);
  });

  it("makes no request at all when this device has no token", async () => {
    clearToken(LEARNER);
    const { impl, calls } = counted();

    expect(await myClasses(LEARNER, { fetchImpl: impl })).toEqual([]);
    expect(calls).toEqual([]);
  });
});
