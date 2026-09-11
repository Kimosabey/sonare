// @vitest-environment jsdom

/**
 * Minting and claiming a link code, from the client.
 *
 * The properties worth testing here are not the happy path — they are the
 * orderings and refusals that stop a device ending up in a state the server
 * disagrees with.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimCode, mintCode } from "./deviceLink.js";
import { readLearnerId, clearLearnerId } from "../lib/learnerId.js";
import { readToken, clearToken } from "./tokenStore.js";
import { LINK_CODE_ALPHABET, LINK_CODE_LENGTH, formatLinkCode } from "../lib/linkCode.js";

const VALID = LINK_CODE_ALPHABET.slice(0, LINK_CODE_LENGTH);
const ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const OTHER_ID = "9c858901-8a57-4791-81fe-4c455b099bc9";

/**
 * jsdom exposes `localStorage` as a bare object with no methods, so every test
 * that touches storage has to install a real one. This has bitten this
 * repository more than once.
 */
function installStorage(): void {
  const map = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, v),
  };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
}

interface Call {
  url: string;
  init: RequestInit;
}

/** A fetch that records what it was asked and answers with a fixed body. */
function stub(status: number, body: unknown): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

beforeEach(() => {
  installStorage();
  clearLearnerId(null);
  clearLearnerId("marie");
  clearLearnerId("ahmed");
  clearToken(null);
  clearToken("marie");
});

afterEach(() => {
  clearLearnerId("marie");
  clearToken("marie");
});

describe("minting a code", () => {
  it("sends the learner's token and returns what the server minted", async () => {
    const { impl, calls } = stub(200, { code: formatLinkCode(VALID), expiresInSeconds: 600 });

    const result = await mintCode("a.b.c", { fetchImpl: impl });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.minted.expiresInSeconds).toBe(600);
    expect(calls[0]?.url).toContain("/api/v1/learners/me/link");
    expect((calls[0]?.init.headers as Record<string, string>)?.authorization).toBe("Bearer a.b.c");
  });

  /**
   * The countdown is driven from elapsed seconds, not the server's wall clock.
   * A phone whose clock is a day out would otherwise show "expires in 23:59:41"
   * over a code that dies in ten minutes.
   */
  it("computes the expiry against this device's clock, not a server timestamp", async () => {
    const { impl } = stub(200, { code: VALID, expiresInSeconds: 600 });
    const before = Date.now();

    const result = await mintCode("a.b.c", { fetchImpl: impl });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.minted.expiresAt).toBeGreaterThanOrEqual(before + 600_000);
      expect(result.minted.expiresAt).toBeLessThan(before + 601_000);
    }
  });

  it("refuses a body with no code rather than showing one no device can claim", async () => {
    for (const body of [{}, { code: "" }, { code: 42 }]) {
      const { impl } = stub(200, body);
      const result = await mintCode("a.b.c", { fetchImpl: impl });
      expect(result.ok).toBe(false);
    }
  });

  it("reports being offline without changing anything", async () => {
    const impl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    const result = await mintCode("a.b.c", { fetchImpl: impl });

    expect(result.ok).toBe(false);
    // No code was created, so nothing local may have moved.
    expect(readLearnerId("marie")).toBeNull();
  });
});

describe("claiming a code", () => {
  it("adopts the identity and saves the token for that learner", async () => {
    const { impl } = stub(200, { token: "x.y.z", learnerId: ID });

    const result = await claimCode(formatLinkCode(VALID), "marie", { fetchImpl: impl });

    expect(result).toEqual({ ok: true, learnerId: ID });
    expect(readLearnerId("marie")).toBe(ID);
    expect(readToken("marie")).toBe("x.y.z");
  });

  /**
   * Refused locally, before a request. The server gives one address ten claim
   * attempts per ten minutes, so spending one on a string the server could not
   * accept under any circumstances would cost a learner a real attempt for a
   * typo.
   */
  it("refuses an impossible code without spending a server attempt", async () => {
    const { impl, calls } = stub(200, { token: "x.y.z", learnerId: ID });

    const result = await claimCode("not-a-code", "marie", { fetchImpl: impl });

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  /**
   * The code goes in the body. A credential in a query string reaches server
   * logs, proxy logs, browser history and any `Referer` the page later sends.
   */
  it("never puts the code in the URL", async () => {
    const { impl, calls } = stub(200, { token: "x.y.z", learnerId: ID });

    await claimCode(formatLinkCode(VALID), "marie", { fetchImpl: impl });

    expect(calls[0]?.url).not.toContain(VALID);
    expect(String(calls[0]?.init.body)).toContain(VALID);
  });

  /**
   * Ordering, and it is load-bearing. A token saved beside an id this device
   * refused would be a credential that disagrees with the id every later
   * request carries — the request would authenticate as one learner while the
   * local record is filed under another.
   */
  it("saves no token when the identity is refused", async () => {
    const { impl } = stub(200, { token: "x.y.z", learnerId: "not-a-uuid" });

    const result = await claimCode(formatLinkCode(VALID), "marie", { fetchImpl: impl });

    expect(result.ok).toBe(false);
    expect(readLearnerId("marie")).toBeNull();
    expect(readToken("marie")).toBeNull();
  });

  it("refuses a body missing either half", async () => {
    for (const body of [{ token: "x.y.z" }, { learnerId: ID }, { token: "", learnerId: ID }]) {
      const { impl } = stub(200, body);
      const result = await claimCode(formatLinkCode(VALID), "marie", { fetchImpl: impl });
      expect(result.ok).toBe(false);
      expect(readToken("marie")).toBeNull();
    }
  });

  /**
   * The reason local storage is keyed per learner name at all: two learners on
   * one device once collided into a single server identity, pooling their
   * streak days and — worse — their sound histories across two different
   * accents, which corrupts the scheduler for both of them silently.
   */
  it("links one learner on a shared device without touching the other", async () => {
    const { impl: first } = stub(200, { token: "a.a.a", learnerId: OTHER_ID });
    await claimCode(formatLinkCode(VALID), "ahmed", { fetchImpl: first });

    const { impl: second } = stub(200, { token: "b.b.b", learnerId: ID });
    await claimCode(formatLinkCode(VALID), "marie", { fetchImpl: second });

    expect(readLearnerId("marie")).toBe(ID);
    expect(readLearnerId("ahmed")).toBe(OTHER_ID);
    expect(readToken("marie")).not.toBe(readToken("ahmed"));
  });

  it("reports being offline without half-linking", async () => {
    const impl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    const result = await claimCode(formatLinkCode(VALID), "marie", { fetchImpl: impl });

    expect(result.ok).toBe(false);
    expect(readLearnerId("marie")).toBeNull();
    expect(readToken("marie")).toBeNull();
  });
});
