// @vitest-environment jsdom

/**
 * The UUID that has to work on a plain-HTTP LAN origin.
 *
 * `crypto.randomUUID()` is secure-context-only, and `http://<lan-ip>:5180` is
 * exactly where the README sends you for on-device testing. Calling it there
 * threw during render and took the whole screen down — while the real problem
 * (the origin) went unreported, because the app died before the capture
 * layer's own INSECURE_CONTEXT message could say so.
 *
 * So the fallbacks are the point of this file, and each is tested with the
 * layer above it actually removed rather than assumed absent.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { newUuid } from "./uuid.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** An insecure context: getRandomValues present, randomUUID gone. */
function insecureContext(): void {
  vi.stubGlobal("crypto", {
    getRandomValues: (b: Uint8Array) => {
      for (let i = 0; i < b.length; i += 1) b[i] = Math.floor(Math.random() * 256);
      return b;
    },
  });
}

describe("with a secure context", () => {
  it("uses the platform UUID", () => {
    const randomUUID = vi.fn(() => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    vi.stubGlobal("crypto", { randomUUID, getRandomValues: () => new Uint8Array(16) });

    expect(newUuid()).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });
});

describe("on a plain-HTTP LAN origin", () => {
  it("still produces a well-formed v4 UUID", () => {
    // Verified in Chrome on such an origin: isSecureContext false, randomUUID
    // undefined, getRandomValues a function.
    insecureContext();

    expect(newUuid()).toMatch(UUID_V4);
  });

  it("pins the version and variant nibbles, as RFC 4122 requires", () => {
    // The two bytes that make it a *valid* v4 rather than 16 random bytes with
    // dashes in it. The regex above checks both positions.
    insecureContext();

    for (let i = 0; i < 40; i += 1) {
      const id = newUuid();
      expect(id[14]).toBe("4");
      expect(["8", "9", "a", "b"]).toContain(id[19]);
    }
  });

  it("does not collide across many calls", () => {
    insecureContext();

    const ids = new Set(Array.from({ length: 500 }, () => newUuid()));

    expect(ids.size).toBe(500);
  });

  it("draws from getRandomValues rather than Math.random", () => {
    // Real entropy is free wherever the API exists, so the weaker path must
    // only be reached when the stronger one is genuinely absent.
    const getRandomValues = vi.fn((b: Uint8Array) => b);
    vi.stubGlobal("crypto", { getRandomValues });

    newUuid();

    expect(getRandomValues).toHaveBeenCalledTimes(1);
  });
});

describe("with no crypto at all", () => {
  it("degrades rather than throwing", () => {
    /**
     * The last resort. A throw here is a blank screen, and this runs during
     * render — so a weaker id is strictly better than no page.
     */
    vi.stubGlobal("crypto", undefined);

    expect(newUuid()).toMatch(UUID_V4);
  });

  it("still avoids collisions well enough to be usable", () => {
    vi.stubGlobal("crypto", undefined);

    const ids = new Set(Array.from({ length: 500 }, () => newUuid()));

    expect(ids.size).toBe(500);
  });

  it("survives a crypto object with no usable method", () => {
    // Not the same as crypto being absent — a partial object is what a
    // polyfill or a locked-down environment tends to leave behind.
    vi.stubGlobal("crypto", {});

    expect(newUuid()).toMatch(UUID_V4);
  });
});
