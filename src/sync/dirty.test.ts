// @vitest-environment jsdom

/**
 * Which work is waiting to be pushed.
 *
 * Persisted rather than held in memory, and that is the whole point: a learner
 * who finishes an activity on a train and closes the tab before the push
 * succeeds must still have it pushed tomorrow. An in-memory flag loses exactly
 * the work that was hardest to do.
 *
 * The subtle one is clearing. Clearing *everything* on a successful push drops
 * the flag for a take scored while the request was in flight, and that work
 * then sits locally forever with nothing marking it unsent — which surfaces
 * only as a learner insisting they did something the server has never heard of.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAllDirty,
  clearDirty,
  hasAnything,
  markLanguageDirty,
  markStreakDirty,
  readDirty,
} from "./dirty.js";

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
const KEY = `sonare.sync.dirty.v1.${LEARNER}`;
const NOTHING = { progress: [], skills: [], streak: false };

beforeEach(() => {
  installStorage();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("marking", () => {
  it("starts with nothing waiting", () => {
    expect(readDirty(LEARNER)).toEqual(NOTHING);
  });

  it("marks progress and skills together for a practised language", () => {
    /**
     * A scored take always produces both — a progress update and new syllable
     * samples — so they are marked together rather than left to a caller who
     * might mark one and forget the other.
     */
    markLanguageDirty(LEARNER, "fr");

    expect(readDirty(LEARNER)).toEqual({ progress: ["fr"], skills: ["fr"], streak: false });
  });

  it("marks the streak separately, since it is per learner", () => {
    markStreakDirty(LEARNER);

    expect(readDirty(LEARNER)).toEqual({ progress: [], skills: [], streak: true });
  });

  it("does not duplicate a language marked twice", () => {
    markLanguageDirty(LEARNER, "fr");
    markLanguageDirty(LEARNER, "fr");

    expect(readDirty(LEARNER).progress).toEqual(["fr"]);
  });

  it("accumulates several languages", () => {
    markLanguageDirty(LEARNER, "fr");
    markLanguageDirty(LEARNER, "es");

    expect(readDirty(LEARNER).progress.sort()).toEqual(["es", "fr"]);
  });

  it("survives a reload", () => {
    // The reason it is in storage at all.
    const store = installStorage();
    markLanguageDirty(LEARNER, "fr");

    installStorage(Object.fromEntries(store));

    expect(readDirty(LEARNER).progress).toEqual(["fr"]);
  });

  it("keeps each learner's flags apart on a shared device", () => {
    markLanguageDirty(LEARNER, "fr");

    expect(readDirty("someone-else")).toEqual(NOTHING);
  });

  it("gives an unnamed learner their own flags", () => {
    markLanguageDirty(null, "fr");

    expect(readDirty(null).progress).toEqual(["fr"]);
    expect(readDirty(LEARNER)).toEqual(NOTHING);
  });

  it("ignores something that is not a language slug", () => {
    // A corrupt or hostile value here would make the client request nonsense
    // and the server reject the whole push.
    for (const bad of ["", "FR", "fr-FR", "../etc", "a".repeat(40)]) {
      markLanguageDirty(LEARNER, bad);
    }

    expect(readDirty(LEARNER)).toEqual(NOTHING);
  });
});

describe("clearing exactly what was pushed", () => {
  it("clears a language that was sent", () => {
    markLanguageDirty(LEARNER, "fr");

    clearDirty(LEARNER, { progress: ["fr"], skills: ["fr"], streak: false });

    expect(readDirty(LEARNER)).toEqual(NOTHING);
  });

  it("leaves a language that was not sent", () => {
    /**
     * The in-flight case. A take scored during the push marks a language that
     * the request did not carry, and clearing everything would drop it — the
     * work would sit locally with nothing to say it was never sent.
     */
    markLanguageDirty(LEARNER, "fr");
    markLanguageDirty(LEARNER, "es");

    clearDirty(LEARNER, { progress: ["fr"], skills: ["fr"], streak: false });

    expect(readDirty(LEARNER)).toEqual({ progress: ["es"], skills: ["es"], streak: false });
  });

  it("leaves the streak when the push did not carry it", () => {
    markStreakDirty(LEARNER);

    clearDirty(LEARNER, { progress: ["fr"], skills: ["fr"], streak: false });

    expect(readDirty(LEARNER).streak).toBe(true);
  });

  it("clears the streak when it did", () => {
    markStreakDirty(LEARNER);

    clearDirty(LEARNER, { progress: [], skills: [], streak: true });

    expect(readDirty(LEARNER).streak).toBe(false);
  });

  it("is harmless when there was nothing to clear", () => {
    expect(() => clearDirty(LEARNER, { progress: ["fr"], skills: [], streak: true })).not.toThrow();
    expect(readDirty(LEARNER)).toEqual(NOTHING);
  });

  it("clears everything on request, for a reset", () => {
    markLanguageDirty(LEARNER, "fr");
    markStreakDirty(LEARNER);

    clearAllDirty(LEARNER);

    expect(readDirty(LEARNER)).toEqual(NOTHING);
  });
});

describe("asking whether there is anything to do", () => {
  it("is false for nothing", () => {
    expect(hasAnything(NOTHING)).toBe(false);
  });

  it("is true for any one domain", () => {
    expect(hasAnything({ progress: ["fr"], skills: [], streak: false })).toBe(true);
    expect(hasAnything({ progress: [], skills: ["fr"], streak: false })).toBe(true);
    expect(hasAnything({ progress: [], skills: [], streak: true })).toBe(true);
  });
});

describe("surviving bad stored data", () => {
  it("reads as nothing waiting on a corrupt value", () => {
    installStorage({ [KEY]: "{not json" });

    expect(readDirty(LEARNER)).toEqual(NOTHING);
  });

  it("drops a stored slug that is not a slug", () => {
    installStorage({ [KEY]: JSON.stringify({ progress: ["fr", "../etc", 7, null], skills: [], streak: 1 }) });

    expect(readDirty(LEARNER)).toEqual({ progress: ["fr"], skills: [], streak: false });
  });

  it("treats a non-boolean streak flag as false rather than truthy", () => {
    // `"false"` and `1` are both truthy, and either would push a streak that
    // had not changed on every single sync.
    installStorage({ [KEY]: JSON.stringify({ progress: [], skills: [], streak: "false" }) });

    expect(readDirty(LEARNER).streak).toBe(false);
  });

  it("ignores flags from an older schema", () => {
    installStorage({ [`sonare.sync.dirty.v0.${LEARNER}`]: JSON.stringify({ progress: ["fr"] }) });

    expect(readDirty(LEARNER)).toEqual(NOTHING);
  });
});

describe("when storage refuses", () => {
  it("reads as nothing waiting rather than throwing", () => {
    /**
     * Nothing dirty means a sync pushes nothing, which is the safe direction:
     * the alternative — assuming everything is dirty — would push every
     * language on every call.
     */
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });

    expect(readDirty(LEARNER)).toEqual(NOTHING);
  });

  it("never throws on a write", () => {
    // This runs immediately after a learner finishes a take.
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });

    expect(() => markLanguageDirty(LEARNER, "fr")).not.toThrow();
    expect(() => markStreakDirty(LEARNER)).not.toThrow();
    expect(() => clearDirty(LEARNER, NOTHING)).not.toThrow();
  });

  it("never throws on a clear", () => {
    vi.spyOn(window.localStorage, "removeItem").mockImplementation(() => {
      throw new Error("nope");
    });

    expect(() => clearAllDirty(LEARNER)).not.toThrow();
  });
});
