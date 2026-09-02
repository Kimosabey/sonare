/**
 * The point of these tests is the insecure-context path, not the happy one.
 * `crypto.randomUUID` is secure-context-only, and the LAN-IP origin the README
 * sends you to for on-device testing does not have it — that gap crashed the
 * activity screen on a real device, so each degradation step is pinned here.
 */

import { describe, expect, it, afterEach, vi } from "vitest";
import { newSessionId } from "./sessionId.js";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const realCrypto = globalThis.crypto;

function setCrypto(value: unknown): void {
  Object.defineProperty(globalThis, "crypto", {
    value,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  setCrypto(realCrypto);
  vi.restoreAllMocks();
});

describe("newSessionId", () => {
  it("uses crypto.randomUUID when the context allows it", () => {
    const randomUUID = vi.fn(() => "11111111-2222-4333-8444-555555555555");
    setCrypto({ randomUUID, getRandomValues: realCrypto.getRandomValues.bind(realCrypto) });

    expect(newSessionId()).toBe("11111111-2222-4333-8444-555555555555");
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });

  it("falls back to getRandomValues when randomUUID is missing (insecure context)", () => {
    // Exactly what Chrome exposes on http://<lan-ip>:5180 — getRandomValues
    // present and working, randomUUID simply absent.
    setCrypto({ getRandomValues: realCrypto.getRandomValues.bind(realCrypto) });

    const id = newSessionId();
    expect(id).toMatch(V4);
  });

  it("still returns a v4-shaped id when crypto is absent entirely", () => {
    setCrypto(undefined);

    expect(newSessionId()).toMatch(V4);
  });

  it("does not collide across many calls on the fallback path", () => {
    setCrypto({ getRandomValues: realCrypto.getRandomValues.bind(realCrypto) });

    const ids = new Set(Array.from({ length: 500 }, () => newSessionId()));
    expect(ids.size).toBe(500);
  });

  it("pins the version and variant nibbles, not just the overall shape", () => {
    // A fallback that forgot §4.4 would still look like a UUID to a loose
    // regex while claiming the wrong version — assert the bytes directly.
    setCrypto({ getRandomValues: (b: Uint8Array) => b.fill(0xff) });

    const id = newSessionId();
    expect(id).toMatch(V4);
    expect(id[14]).toBe("4");
    expect(["8", "9", "a", "b"]).toContain(id[19]);
  });
});
