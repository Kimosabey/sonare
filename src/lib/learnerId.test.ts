// @vitest-environment jsdom

/**
 * The identity everything server-side will hang off, and the ways it can
 * quietly become the wrong one.
 *
 * It can be *unstable* — minting a fresh id per call where storage is blocked
 * would split one session's progress, skills and streak across several
 * learners, and nothing would look broken. It can be *shared* — a stored value
 * of "" or "null" keys a bucket every learner on the device lands in. And a
 * reset can look like it worked while handing back the same identity.
 *
 * jsdom exposes `localStorage` as a bare object with no methods, so every test
 * here installs a real in-memory Storage. Without that they would pass
 * vacuously.
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

const KEY = "sonare.learnerId.v1";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAMPLE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

/** Fresh module each time — the in-memory fallback is module state. */
async function load() {
  vi.resetModules();
  return import("./learnerId.js");
}

beforeEach(() => {
  installStorage();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("minting", () => {
  it("has no id before one is asked for", async () => {
    // The picker's name gate and the home screen both need to tell a first
    // visit from a return, so this must not mint as a side effect of reading.
    const { readLearnerId } = await load();

    expect(readLearnerId()).toBeNull();
  });

  it("mints a well-formed id on first use", async () => {
    const { ensureLearnerId } = await load();

    expect(ensureLearnerId()).toMatch(UUID_V4);
  });

  it("persists it, so the same browser is the same learner", async () => {
    const { ensureLearnerId } = await load();

    const first = ensureLearnerId();

    expect(localStorage.getItem(KEY)).toBe(first);
    expect(ensureLearnerId()).toBe(first);
  });

  it("survives a reload", async () => {
    const store = installStorage();
    const first = await load();
    const minted = first.ensureLearnerId();

    // A reload is a fresh module against the same storage.
    installStorage(Object.fromEntries(store));
    const second = await load();

    expect(second.ensureLearnerId()).toBe(minted);
  });

  it("reads an id a previous session stored", async () => {
    installStorage({ [KEY]: SAMPLE });
    const { readLearnerId, ensureLearnerId } = await load();

    expect(readLearnerId()).toBe(SAMPLE);
    expect(ensureLearnerId()).toBe(SAMPLE);
  });
});

describe("refusing a value that is not an identity", () => {
  it.each([
    ["empty", ""],
    ["the string null", "null"],
    ["the string undefined", "undefined"],
    ["not a uuid", "marie"],
    ["truncated", "aaaaaaaa-bbbb-4ccc"],
    ["a json object", '{"id":1}'],
  ])("replaces %s rather than keying progress on it", async (_label, bad) => {
    /**
     * Each of these would otherwise become a shared bucket: every learner on
     * the device whose storage held the same junk would land on the same
     * server-side record. Validated rather than trusted, because this value
     * outlives the code that wrote it and is trivially editable.
     */
    installStorage({ [KEY]: bad });
    const { readLearnerId, ensureLearnerId } = await load();

    expect(readLearnerId()).toBeNull();

    const minted = ensureLearnerId();
    expect(minted).toMatch(UUID_V4);
    expect(minted).not.toBe(bad);
  });

  it("ignores an id from an older schema", async () => {
    installStorage({ "sonare.learnerId.v0": SAMPLE });
    const { readLearnerId } = await load();

    expect(readLearnerId()).toBeNull();
  });
});

describe("when storage will not cooperate", () => {
  it("keeps one id for the whole session even though nothing persists", async () => {
    /**
     * The bug worth having a test for. Without an in-memory fallback, every
     * call mints a fresh id — so a single session's progress, skills and
     * streak would be attributed to several different learners, and no screen
     * would look wrong.
     */
    const { ensureLearnerId } = await load();
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });

    const first = ensureLearnerId();

    expect(first).toMatch(UUID_V4);
    expect(ensureLearnerId()).toBe(first);
    expect(ensureLearnerId()).toBe(first);
  });

  it("reads through to the session id when getItem throws", async () => {
    const { ensureLearnerId, readLearnerId } = await load();
    const minted = ensureLearnerId();

    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });

    expect(readLearnerId()).toBe(minted);
  });

  it("never throws, because every screen needing an id needs to render", async () => {
    const { ensureLearnerId, readLearnerId, clearLearnerId } = await load();
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("nope");
    });
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("nope");
    });
    vi.spyOn(window.localStorage, "removeItem").mockImplementation(() => {
      throw new Error("nope");
    });

    expect(() => readLearnerId()).not.toThrow();
    expect(() => ensureLearnerId()).not.toThrow();
    expect(() => clearLearnerId()).not.toThrow();
  });
});

describe("forgetting", () => {
  it("clears the id, for a reset or a deletion request", async () => {
    const { ensureLearnerId, readLearnerId, clearLearnerId } = await load();
    ensureLearnerId();

    clearLearnerId();

    expect(readLearnerId()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("mints a genuinely different id afterwards", async () => {
    // Otherwise a reset looks like it worked and hands back the same identity
    // for the rest of the session, because the in-memory copy survived.
    const { ensureLearnerId, clearLearnerId } = await load();
    const before = ensureLearnerId();

    clearLearnerId();

    expect(ensureLearnerId()).not.toBe(before);
  });

  it("clears the in-memory copy even when removeItem throws", async () => {
    const { ensureLearnerId, clearLearnerId, readLearnerId } = await load();
    ensureLearnerId();
    vi.spyOn(window.localStorage, "removeItem").mockImplementation(() => {
      throw new Error("nope");
    });
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => null);

    clearLearnerId();

    expect(readLearnerId()).toBeNull();
  });
});

describe("what it is not", () => {
  it("is anonymous — no name, no email, nothing personal", async () => {
    /**
     * A structural check on a promise the doc comment makes. The id is a v4
     * UUID and nothing else, so it cannot carry a name or an address even by
     * accident, and the type gives a caller nowhere to put one.
     */
    const { ensureLearnerId } = await load();

    expect(ensureLearnerId()).toMatch(UUID_V4);
    expect(localStorage.getItem(KEY)).toMatch(UUID_V4);
  });
});
