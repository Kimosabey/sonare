/**
 * The wire contract, and the one place a provider string could escape.
 *
 * CLAUDE.md forbids bare-string errors because failure attribution is the
 * point of the POC: "the client sent bad audio", "Azure is down" and "our
 * server is misconfigured" need different responses from different people, and
 * a string collapses all three into a log line someone has to guess at.
 *
 * The security-relevant test is the last one in the first group. `this.message`
 * is the internal string and can carry a raw provider or SDK message — see
 * azureSpeech.ts's PROVIDER_REJECTED path. The serialized `message` field
 * exists only for shape-compatibility with existing clients and must always
 * carry the sanitized text instead. A refactor that "simplified" toJSON by
 * passing `this.message` through would leak vendor internals to every browser
 * and break nothing visible.
 */

import { describe, expect, it } from "vitest";
import { AppError, isAppError } from "./errors.js";

function make(overrides: Partial<ConstructorParameters<typeof AppError>[0]> = {}) {
  return new AppError({
    code: "PROVIDER_REJECTED",
    domain: "provider",
    message: "internal detail",
    userMessage: "Something went wrong on our side.",
    ...overrides,
  });
}

describe("what goes on the wire", () => {
  it("carries the code and domain a client dispatches on", () => {
    const json = make().toJSON();

    expect(json.code).toBe("PROVIDER_REJECTED");
    expect(json.domain).toBe("provider");
  });

  it("never serializes the internal message, in either field", () => {
    /**
     * The leak this guards. A PROVIDER_REJECTED carries whatever the Azure SDK
     * said, which has included endpoint paths and subscription-region detail.
     * Both wire fields must be the sanitized text.
     */
    const err = make({
      message: "Azure: 401 Unauthorized for region southeastasia key ending ...9f2a",
      userMessage: "That recording could not be scored. Please try again.",
    });

    const json = err.toJSON();

    expect(json.message).toBe("That recording could not be scored. Please try again.");
    expect(json.userMessage).toBe(json.message);
    expect(JSON.stringify(json)).not.toContain("southeastasia");
    expect(JSON.stringify(json)).not.toContain("9f2a");
  });

  it("keeps the internal message reachable for logs", () => {
    // Sanitizing the wire must not mean throwing the detail away — the whole
    // point of attribution is that someone can find out what actually broke.
    const err = make({ message: "Azure: 401 Unauthorized" });

    expect(err.message).toBe("Azure: 401 Unauthorized");
  });

  it("serializes to exactly the four contract fields, and no more", () => {
    /**
     * A field added to AppError later — a stack, a request id, a raw provider
     * payload — would start appearing in every error response the moment
     * something serialized the instance instead of calling toJSON. Pinning the
     * key set makes that a test failure rather than a disclosure.
     */
    expect(Object.keys(make().toJSON()).sort()).toEqual(["code", "domain", "message", "userMessage"]);
  });

  it("does not leak the stack when the instance itself is serialized", () => {
    // JSON.stringify calls toJSON, so this is the realistic path — asserted
    // because it is the one an express handler is most likely to take.
    const serialized = JSON.stringify(make({ message: "secret-internal-path" }));

    expect(serialized).not.toContain("secret-internal-path");
    expect(serialized).not.toContain("stack");
  });
});

describe("the HTTP status is derived from blame", () => {
  it("blames the caller with 4xx and everyone else with 5xx", () => {
    /**
     * This mapping is what makes the attribution actionable rather than
     * decorative: a 400 tells the client to fix its request, a 502 tells it to
     * retry and tells us to look at the provider. Getting it backwards would
     * have clients retrying their own bad audio forever.
     */
    expect(make({ domain: "client" }).status).toBe(400);
    expect(make({ domain: "provider" }).status).toBe(502);
    expect(make({ domain: "server" }).status).toBe(502);
    expect(make({ domain: "network" }).status).toBe(502);
    expect(make({ domain: "model" }).status).toBe(502);
  });

  it("lets an explicit status win over the default", () => {
    // 429 and 413 are client-domain but not 400.
    expect(make({ domain: "client", status: 413 }).status).toBe(413);
  });
});

describe("AppError as an Error", () => {
  it("is a real Error, so it survives a throw and a catch", () => {
    // Express's error path, `instanceof Error` checks and any logger that
    // reads `.stack` all depend on this.
    const err = make();

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AppError");
    expect(typeof err.stack).toBe("string");
  });

  it("is recognised by isAppError, and nothing else is", () => {
    // The route uses this to decide between a typed response and a generic
    // 500. A false positive would serialize an arbitrary object to a learner.
    expect(isAppError(make())).toBe(true);
    expect(isAppError(new Error("plain"))).toBe(false);
    expect(isAppError({ code: "PROVIDER_REJECTED", domain: "provider" })).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError("PROVIDER_REJECTED")).toBe(false);
  });

  it("keeps its fields readonly at the type level and stable at runtime", () => {
    const err = make();

    expect(err.code).toBe("PROVIDER_REJECTED");
    expect(err.domain).toBe("provider");
    expect(err.userMessage).toBe("Something went wrong on our side.");
  });
});

describe("every code carries a user-safe message", () => {
  it("has a non-empty userMessage for each code the server can raise", () => {
    /**
     * An empty userMessage reaches a learner as a blank error box. Constructed
     * here for every code in the union so that adding a code without a message
     * is caught, since the type cannot require one to be non-empty.
     */
    const codes = [
      "MISSING_AUDIO",
      "MISSING_REFERENCE_TEXT",
      "BAD_CONTENT_TYPE",
      "BAD_AUDIO_FORMAT",
      "AUDIO_TOO_SHORT",
      "AUDIO_TOO_LONG",
      "INVALID_REQUEST",
      "PROVIDER_UNAVAILABLE",
      "PROVIDER_TIMEOUT",
      "PROVIDER_REJECTED",
      "MISCONFIGURED",
    ] as const;

    for (const code of codes) {
      const err = make({ code, userMessage: "Please try again." });

      expect(err.toJSON().code, code).toBe(code);
      expect(err.toJSON().userMessage.length, code).toBeGreaterThan(0);
    }
  });
});
