// @vitest-environment jsdom

/**
 * The store that already broke production once.
 *
 * A learner mid-session who refreshes should not lose ten activities of work,
 * so this persists. But it persists *scored results* — and a saved result
 * outlives the type that described it. When `ScoredWord.syllables` became
 * required, every entry written before that change restored words with no
 * syllables at all, and report.ts threw "word.syllables is not iterable" the
 * moment a saved session was reopened. Not on the next deploy: on the next
 * *refresh*, for anyone who had already played.
 *
 * The defence is the schema version inside the storage key, so a bump orphans
 * old data rather than reading it. That is a smaller cost than the
 * alternative: the learner starts that language fresh instead of hitting a
 * white screen they cannot get past by retrying.
 *
 * Everything else here is about a convenience feature never being allowed to
 * take the page down — private browsing, a full quota, a corrupt value, a
 * value of the wrong shape entirely.
 */

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProgressPersistence } from "./useProgressPersistence.js";
import type { PersistedProgress } from "./useProgressPersistence.js";

/**
 * jsdom in this project exposes `localStorage` as a bare object with no
 * methods, so the hook's own try/catch would swallow every call and these
 * tests would all pass vacuously. A real in-memory Storage is installed
 * instead — which also makes the throwing cases below precise, since they can
 * replace one method rather than hoping a prototype spy is on the path the
 * hook actually takes.
 */
function installStorage(): Record<string, string> {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  return Object.fromEntries(data) as Record<string, string>;
}

/** Keys currently held, since a bare object has no enumerable entries. */
function storedKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k !== null) keys.push(k);
  }
  return keys;
}

const SLUG = "french";
const LEARNER = "harshan";

function keyFor(version: string, slug = SLUG, learner: string | null = LEARNER): string {
  return `sonare.progress.${version}.${slug}.${learner ?? "anonymous"}`;
}

/** The current key, discovered from a save rather than hardcoded twice. */
function currentKey(slug = SLUG, learner: string | null = LEARNER): string {
  const { result } = renderHook(() => useProgressPersistence(slug, learner));
  result.current.save({ index: 0, progress: [], finished: false });
  const found = storedKeys().find((k) => k.includes(`.${slug}.${learner ?? "anonymous"}`));
  localStorage.clear();
  return found ?? "";
}

beforeEach(() => {
  installStorage();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("surviving a refresh", () => {
  it("restores what was saved", () => {
    const saved: PersistedProgress = { index: 4, progress: [], finished: false };
    const first = renderHook(() => useProgressPersistence(SLUG, LEARNER));
    first.result.current.save(saved);

    const second = renderHook(() => useProgressPersistence(SLUG, LEARNER));

    expect(second.result.current.initial).toEqual(saved);
  });

  it("starts empty with nothing stored", () => {
    const { result } = renderHook(() => useProgressPersistence(SLUG, LEARNER));

    expect(result.current.initial).toEqual({ index: 0, progress: [], finished: false });
  });

  it("reads once at mount and does not fight the caller's own state afterwards", () => {
    /**
     * `initial` seeds the caller's useState. If it re-read on every render it
     * would keep resetting the caller to whatever is on disk, and every
     * in-session advance would snap back.
     */
    const { result, rerender } = renderHook(() => useProgressPersistence(SLUG, LEARNER));
    const seed = result.current.initial;

    localStorage.setItem(currentKey(), JSON.stringify({ index: 9, progress: [], finished: true }));
    rerender();

    expect(result.current.initial).toBe(seed);
  });

  it("clear() removes the entry, so starting over really starts over", () => {
    const { result } = renderHook(() => useProgressPersistence(SLUG, LEARNER));
    result.current.save({ index: 7, progress: [], finished: true });

    result.current.clear();

    const reopened = renderHook(() => useProgressPersistence(SLUG, LEARNER));
    expect(reopened.result.current.initial.index).toBe(0);
  });
});

describe("the schema version, which is why the crash cannot recur", () => {
  it("ignores an entry written under an older schema", () => {
    /**
     * The v1 shape verbatim: results whose words carry no `syllables`. Read
     * back, it crashed report.ts on "word.syllables is not iterable". The
     * version in the key means it is not read back at all.
     */
    localStorage.setItem(
      keyFor("v1"),
      JSON.stringify({
        index: 5,
        finished: false,
        progress: [
          {
            activityId: 1,
            best: 88,
            passed: true,
            attempts: [{ accuracy: 88, words: [{ word: "bonjour", accuracy: 88 }] }],
          },
        ],
      }),
    );

    const { result } = renderHook(() => useProgressPersistence(SLUG, LEARNER));

    expect(result.current.initial.index).toBe(0);
    expect(result.current.initial.progress).toEqual([]);
  });

  it("orphans the old entry rather than deleting it", () => {
    // Not read, but not destroyed either — a stored value is the learner's,
    // and silently clearing storage a bump made unreadable is a decision
    // nobody asked for.
    localStorage.setItem(keyFor("v1"), JSON.stringify({ index: 5 }));

    renderHook(() => useProgressPersistence(SLUG, LEARNER));

    expect(localStorage.getItem(keyFor("v1"))).not.toBeNull();
  });

  it("writes under a versioned key, so the next bump can orphan this one too", () => {
    const { result } = renderHook(() => useProgressPersistence(SLUG, LEARNER));

    result.current.save({ index: 1, progress: [], finished: false });

    const written = storedKeys().filter((k) => k.startsWith("sonare.progress."));
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^sonare\.progress\.v\d+\./);
  });
});

describe("keeping learners and languages apart", () => {
  it("does not leak one language's progress into another", () => {
    // Ten French activities restored on the Spanish screen would show a
    // learner passes they never earned.
    const french = renderHook(() => useProgressPersistence("french", LEARNER));
    french.result.current.save({ index: 6, progress: [], finished: false });

    const spanish = renderHook(() => useProgressPersistence("spanish", LEARNER));

    expect(spanish.result.current.initial.index).toBe(0);
  });

  it("does not leak one learner's progress into another on a shared device", () => {
    // A fixture session runs several speakers through one browser.
    const first = renderHook(() => useProgressPersistence(SLUG, "speaker-a"));
    first.result.current.save({ index: 3, progress: [], finished: false });

    const second = renderHook(() => useProgressPersistence(SLUG, "speaker-b"));

    expect(second.result.current.initial.index).toBe(0);
  });

  it("gives an unnamed learner a stable bucket of their own", () => {
    // Not a crash and not shared with a named learner.
    const anon = renderHook(() => useProgressPersistence(SLUG, null));
    anon.result.current.save({ index: 2, progress: [], finished: false });

    const again = renderHook(() => useProgressPersistence(SLUG, null));
    const named = renderHook(() => useProgressPersistence(SLUG, "someone"));

    expect(again.result.current.initial.index).toBe(2);
    expect(named.result.current.initial.index).toBe(0);
  });
});

describe("a convenience feature must never take the page down", () => {
  it("starts fresh on a corrupt value instead of throwing", () => {
    // Storage can be edited by hand, or truncated by a crash mid-write.
    localStorage.setItem(currentKey(), "{not json");

    const { result } = renderHook(() => useProgressPersistence(SLUG, LEARNER));

    expect(result.current.initial).toEqual({ index: 0, progress: [], finished: false });
  });

  it("coerces a value of the wrong shape rather than trusting the cast", () => {
    /**
     * `JSON.parse(...) as Partial<PersistedProgress>` is a claim, not a check —
     * this is exactly the gap the v1 crash came through. Each field is
     * validated on read, so a hostile or ancient value degrades to the empty
     * state instead of reaching a render loop.
     */
    localStorage.setItem(
      currentKey(),
      JSON.stringify({ index: "five", progress: { not: "an array" }, finished: "yes" }),
    );

    const { result } = renderHook(() => useProgressPersistence(SLUG, LEARNER));

    expect(result.current.initial.index).toBe(0);
    expect(result.current.initial.progress).toEqual([]);
    expect(result.current.initial.finished).toBe(false);
  });

  it("treats a truthy-but-not-true finished flag as not finished", () => {
    // `finished === true` rather than a truthiness check: a stored "false"
    // string is truthy and would jump a learner straight to the report.
    localStorage.setItem(currentKey(), JSON.stringify({ index: 2, progress: [], finished: "false" }));

    const { result } = renderHook(() => useProgressPersistence(SLUG, LEARNER));

    expect(result.current.initial.finished).toBe(false);
  });

  it("reads through a getItem that throws, as in private browsing", () => {
    // Safari private mode throws rather than returning null. Falling through
    // to the empty state keeps the session working, just not resumable.
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });

    const { result } = renderHook(() => useProgressPersistence(SLUG, LEARNER));

    expect(result.current.initial).toEqual({ index: 0, progress: [], finished: false });
  });

  it("survives a setItem that throws on a full quota", () => {
    /**
     * The important one: this fires mid-session, after the learner has already
     * recorded. The session must continue on in-memory state — losing
     * resumability is a cost, losing the take is not acceptable.
     */
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    const { result } = renderHook(() => useProgressPersistence(SLUG, LEARNER));

    expect(() => result.current.save({ index: 3, progress: [], finished: false })).not.toThrow();
  });

  it("survives a removeItem that throws", () => {
    vi.spyOn(window.localStorage, "removeItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    const { result } = renderHook(() => useProgressPersistence(SLUG, LEARNER));

    expect(() => result.current.clear()).not.toThrow();
  });
});
