/**
 * Table-driven coverage for every CaptureErrorCode — both construction paths:
 * a direct captureError() call, and fromGetUserMediaError()'s mapping from a
 * getUserMedia DOMException. CLAUDE.md: "never bare strings" for errors; this
 * locks in that every code actually has a real, distinct, user-facing
 * message rather than a placeholder nobody filled in for a newer code.
 */

import { describe, expect, it } from "vitest";
import { captureError, fromGetUserMediaError } from "./errors.js";
import type { CaptureErrorCode } from "./errors.js";

const ALL_CODES: CaptureErrorCode[] = [
  "GESTURE_REQUIRED",
  "UNSUPPORTED_BROWSER",
  "PERMISSION_DENIED",
  "PERMISSION_DISMISSED",
  "NO_MICROPHONE",
  "DEVICE_LOST",
  "CONTEXT_SUSPENDED",
  "NO_AUDIO_ENERGY",
  "TOO_SHORT",
  "TOO_LONG",
  "SNR_TOO_LOW",
  "INSECURE_CONTEXT",
  "INTERRUPTED",
  "ROUTE_CHANGED",
  "UNSUPPORTED_SAMPLE_RATE",
];

describe("captureError", () => {
  it.each(ALL_CODES)("%s carries its own code, a real userMessage, and the given detail as message", (code) => {
    const err = captureError(code, `detail for ${code}`);
    expect(err.code).toBe(code);
    expect(err.message).toBe(`detail for ${code}`);
    expect(err.userMessage.length).toBeGreaterThan(0);
    expect(err.domain).toBe("client"); // default when no domain is passed
  });

  it("every code maps to its own distinct userMessage — no code silently sharing another's placeholder text", () => {
    const messages = ALL_CODES.map((code) => captureError(code, "x").userMessage);
    expect(new Set(messages).size).toBe(ALL_CODES.length);
  });

  it("accepts an explicit domain override instead of defaulting to client", () => {
    const err = captureError("DEVICE_LOST", "detail", "provider");
    expect(err.domain).toBe("provider");
  });
});

describe("fromGetUserMediaError", () => {
  function domException(name: string, message = "boom"): DOMException {
    return new DOMException(message, name);
  }

  it.each([
    ["NotAllowedError", true, "PERMISSION_DENIED"],
    ["NotAllowedError", false, "PERMISSION_DISMISSED"],
    ["SecurityError", true, "PERMISSION_DENIED"],
    ["SecurityError", false, "PERMISSION_DISMISSED"],
    ["NotFoundError", true, "NO_MICROPHONE"],
    ["NotFoundError", false, "NO_MICROPHONE"],
    ["OverconstrainedError", true, "NO_MICROPHONE"],
    ["NotReadableError", true, "DEVICE_LOST"],
    ["AbortError", true, "DEVICE_LOST"],
    ["SomeFutureDOMExceptionNobodyMappedYet", true, "UNSUPPORTED_BROWSER"],
  ] as const)("DOMException '%s' (promptWasFast=%s) maps to %s", (name, promptWasFast, expectedCode) => {
    const err = fromGetUserMediaError(domException(name), promptWasFast);
    expect(err.code).toBe(expectedCode);
  });

  it("PERMISSION_DENIED vs PERMISSION_DISMISSED is decided by prompt timing, not the exception itself", () => {
    // Same exception, only `promptWasFast` differs — the one signal that
    // actually distinguishes "the user already has this blocked" from
    // "the user just tapped away from a live prompt."
    const denied = fromGetUserMediaError(domException("NotAllowedError"), true);
    const dismissed = fromGetUserMediaError(domException("NotAllowedError"), false);
    expect(denied.code).toBe("PERMISSION_DENIED");
    expect(dismissed.code).toBe("PERMISSION_DISMISSED");
  });

  it("falls back to UNSUPPORTED_BROWSER for a rejection that's neither an Error nor a DOMException", () => {
    const err = fromGetUserMediaError("a plain string rejection", true);
    expect(err.code).toBe("UNSUPPORTED_BROWSER");
  });

  it("the mapped error's userMessage is the real user-facing text, never the raw DOMException message", () => {
    const err = fromGetUserMediaError(domException("NotAllowedError", "boom"), true);
    expect(err.userMessage).not.toContain("boom");
    expect(err.userMessage.length).toBeGreaterThan(0);
    // The raw detail is preserved too — just not surfaced as userMessage.
    expect(err.message).toBe("boom");
  });
});
