// @vitest-environment jsdom

/**
 * Asked once, then remembered — and the "remembered" half has to be optional.
 *
 * The name is not decoration: it keys the progress store and lands in every
 * attempt record, which is how the fixture analysis groups eighty recordings
 * by speaker. But the storage it uses can refuse. Safari private browsing
 * throws on access rather than returning null, and a device with storage
 * disabled throws on write. Neither is allowed to stop a learner reaching the
 * activities — the cost of that failure is the whole session, against a
 * benefit of not retyping a name.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLearnerName } from "./useLearnerName.js";

const KEY = "sonare.learnerName";

/**
 * jsdom here exposes `localStorage` as a bare object with no methods, so the
 * hook's own try/catch would swallow every call and these tests would pass
 * without exercising anything. A real in-memory Storage is installed instead.
 */
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

beforeEach(() => {
  installStorage();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("remembering", () => {
  it("starts with no name on a first visit", () => {
    const { result } = renderHook(() => useLearnerName());

    expect(result.current[0]).toBeNull();
  });

  it("restores a name stored on a previous visit", () => {
    installStorage({ [KEY]: "Harshan" });

    const { result } = renderHook(() => useLearnerName());

    expect(result.current[0]).toBe("Harshan");
  });

  it("reports the new name immediately, before anything is persisted", () => {
    // The picker navigates on set, so the value has to be usable synchronously
    // rather than after a storage round trip.
    const { result } = renderHook(() => useLearnerName());

    act(() => result.current[1]("Marie"));

    expect(result.current[0]).toBe("Marie");
  });

  it("persists under the key the rest of the product reads", () => {
    // Diagnostics.tsx and the progress store both build on this name. A
    // renamed key silently splits one learner into two.
    const data = installStorage();
    const { result } = renderHook(() => useLearnerName());

    act(() => result.current[1]("Marie"));

    expect(data.get(KEY)).toBe("Marie");
  });

  it("survives a reload", () => {
    const data = installStorage();
    const first = renderHook(() => useLearnerName());
    act(() => first.result.current[1]("Marie"));

    installStorage(Object.fromEntries(data));
    const second = renderHook(() => useLearnerName());

    expect(second.result.current[0]).toBe("Marie");
  });

  it("replaces rather than accumulating when a different speaker takes over", () => {
    /**
     * A fixture session runs several speakers through one browser, and the
     * progress store is keyed on this name — so a stale name would file one
     * speaker's attempts under another's, which is the one error the analysis
     * cannot detect afterwards.
     */
    const data = installStorage({ [KEY]: "speaker-a" });
    const { result } = renderHook(() => useLearnerName());

    act(() => result.current[1]("speaker-b"));

    expect(result.current[0]).toBe("speaker-b");
    expect(data.get(KEY)).toBe("speaker-b");
  });
});

describe("when storage refuses", () => {
  it("falls back to asking, rather than throwing on the intro screen", () => {
    /**
     * Safari private browsing throws on access. This hook runs on the first
     * screen a learner sees, so an escaping error is a blank page before
     * they have done anything at all.
     */
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });

    const { result } = renderHook(() => useLearnerName());

    expect(result.current[0]).toBeNull();
  });

  it("keeps the name for the rest of the visit when the write fails", () => {
    /**
     * The distinction that matters: persistence is the convenience, the name
     * itself is load-bearing. A learner on a locked-down device must still be
     * able to complete a session — they just have to retype the name next
     * time.
     */
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    const { result } = renderHook(() => useLearnerName());

    act(() => result.current[1]("Marie"));

    expect(result.current[0]).toBe("Marie");
  });

  it("does not throw out of the setter", () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("nope");
    });
    const { result } = renderHook(() => useLearnerName());

    expect(() => act(() => result.current[1]("Marie"))).not.toThrow();
  });
});

describe("the setter identity", () => {
  it("is stable across renders, so effects keyed on it do not re-run", () => {
    // Callers put this in dependency arrays. A new function each render would
    // re-run whatever it seeds on every keystroke of the name field.
    const { result, rerender } = renderHook(() => useLearnerName());
    const setter = result.current[1];

    rerender();

    expect(result.current[1]).toBe(setter);
  });
});
