/**
 * The only authentication in the product, and it was untested.
 *
 * `GET /diagnostics` and `GET /attempts` expose every learner's spoken phrases,
 * device details and session ids across all sessions. The token gate is the
 * whole of what stands in front of that, so a regression here does not degrade
 * a feature — it publishes the data the privacy posture depends on keeping.
 *
 * Two properties matter more than the rest. It must **fail closed** when
 * `DIAGNOSTICS_TOKEN` is unset, because otherwise a forgotten environment
 * variable is the difference between internal-only and world-readable. And the
 * write endpoint must stay open, because it is fire-and-forget telemetry from
 * a learner's browser that has no token to send.
 *
 * Real Express on an ephemeral port. Mongo-touching modules are stubbed; the
 * gate is what is under test.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const listDiagnostics = vi.fn(() => Promise.resolve([{ code: "SNR_TOO_LOW" }]));
const listAttempts = vi.fn(() => Promise.resolve([{ referenceText: "Bonjour" }]));
const listDiagnosticsFor = vi.fn(() => Promise.resolve([{ code: "NO_AUDIO_ENERGY" }]));
const listAttemptsFor = vi.fn(() => Promise.resolve([{ referenceText: "Bonjour" }]));
const recordDiagnostic = vi.fn(() => Promise.resolve());

vi.mock("../diagnostics.js", () => ({
  listDiagnostics: (...a: unknown[]) => listDiagnostics(...(a as [])),
  listDiagnosticsFor: (...a: unknown[]) => listDiagnosticsFor(...(a as [])),
  recordDiagnostic: (...a: unknown[]) => recordDiagnostic(...(a as [])),
}));
vi.mock("../attempts.js", () => ({
  listAttempts: (...a: unknown[]) => listAttempts(...(a as [])),
  listAttemptsFor: (...a: unknown[]) => listAttemptsFor(...(a as [])),
}));
vi.mock("../spend.js", () => ({ getSpendReport: () => Promise.resolve({ allTime: { calls: 0 } }) }));
vi.mock("../rateLimit.js", () => ({
  diagnosticsLimiter: (_q: unknown, _s: unknown, next: () => void) => next(),
  scoringLimiter: (_q: unknown, _s: unknown, next: () => void) => next(),
}));

const TOKEN = "s3cret-token-value";
const ORIGINAL = process.env.DIAGNOSTICS_TOKEN;

let server: Server;
let base: string;

beforeAll(async () => {
  process.env.DIAGNOSTICS_TOKEN = TOKEN;
  const express = (await import("express")).default;
  const { diagnosticsRouter } = await import("./diagnostics.js");
  const app = express();
  app.use(express.json());
  app.use("/api/v1", diagnosticsRouter);
  await new Promise<void>((ready) => {
    server = app.listen(0, () => ready());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (ORIGINAL === undefined) delete process.env.DIAGNOSTICS_TOKEN;
  else process.env.DIAGNOSTICS_TOKEN = ORIGINAL;
  await new Promise<void>((done) => server.close(() => done()));
});

beforeEach(() => {
  vi.clearAllMocks();
  listDiagnostics.mockResolvedValue([{ code: "SNR_TOO_LOW" }]);
  listAttempts.mockResolvedValue([{ referenceText: "Bonjour" }]);
  listDiagnosticsFor.mockResolvedValue([{ code: "NO_AUDIO_ENERGY" }]);
  listAttemptsFor.mockResolvedValue([{ referenceText: "Bonjour" }]);
});

afterEach(() => {
  process.env.DIAGNOSTICS_TOKEN = TOKEN;
});

const READS = ["/api/v1/diagnostics", "/api/v1/attempts", "/api/v1/spend"] as const;

describe("the read endpoints are gated", () => {
  it.each(READS)("refuses %s with no token at all", async (path) => {
    const res = await fetch(`${base}${path}`);

    expect(res.status).toBe(401);
    expect(listAttempts).not.toHaveBeenCalled();
    expect(listDiagnostics).not.toHaveBeenCalled();
  });

  it.each(READS)("refuses %s with a wrong token", async (path) => {
    const res = await fetch(`${base}${path}`, { headers: { "x-diagnostics-token": "wrong" } });

    expect(res.status).toBe(401);
  });

  it.each(READS)("allows %s with the right token", async (path) => {
    const res = await fetch(`${base}${path}`, { headers: { "x-diagnostics-token": TOKEN } });

    expect(res.status).toBe(200);
  });

  it("refuses a token that is a prefix of the real one", async () => {
    // The length check short-circuits before timingSafeEqual, which throws on
    // mismatched lengths rather than returning false.
    const res = await fetch(`${base}/api/v1/attempts`, {
      headers: { "x-diagnostics-token": TOKEN.slice(0, -1) },
    });

    expect(res.status).toBe(401);
  });

  it("refuses a token with the right length but wrong content", async () => {
    // The case that actually reaches timingSafeEqual.
    const wrong = "x".repeat(TOKEN.length);
    const res = await fetch(`${base}/api/v1/attempts`, {
      headers: { "x-diagnostics-token": wrong },
    });

    expect(res.status).toBe(401);
  });

  it("leaks nothing about the token in a refusal", async () => {
    const res = await fetch(`${base}/api/v1/attempts`, {
      headers: { "x-diagnostics-token": "wrong" },
    });
    const body = (await res.json()) as { error: string };

    expect(body.error).not.toContain(TOKEN);
    expect(body.error).not.toMatch(/length|expected/i);
  });

  it("returns the records once past the gate", async () => {
    const res = await fetch(`${base}/api/v1/attempts`, {
      headers: { "x-diagnostics-token": TOKEN },
    });
    const body = (await res.json()) as { records: { referenceText: string }[] };

    expect(body.records[0]?.referenceText).toBe("Bonjour");
  });
});

describe("fail closed when no token is configured", () => {
  it("refuses reads rather than opening them", async () => {
    /**
     * The property this whole design turns on. An "unset means open" fallback
     * would make a forgotten environment variable the difference between an
     * internal screen and a public export of every learner's spoken phrases.
     */
    delete process.env.DIAGNOSTICS_TOKEN;

    for (const path of READS) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(401);
    }
    expect(listAttempts).not.toHaveBeenCalled();
  });

  it("says it is disabled rather than implying a bad token", async () => {
    // An operator who forgot the variable needs to be told that, not sent
    // hunting for a token they never set.
    delete process.env.DIAGNOSTICS_TOKEN;

    const res = await fetch(`${base}/api/v1/attempts`);
    const body = (await res.json()) as { error: string };

    expect(body.error).toMatch(/disabled/i);
    expect(body.error).toContain("DIAGNOSTICS_TOKEN");
  });

  it("refuses even when a token is sent, since there is nothing to check it against", async () => {
    delete process.env.DIAGNOSTICS_TOKEN;

    const res = await fetch(`${base}/api/v1/attempts`, {
      headers: { "x-diagnostics-token": TOKEN },
    });

    expect(res.status).toBe(401);
  });
});

describe("the write endpoint stays open", () => {
  it("accepts a client report without a token", async () => {
    /**
     * Deliberately ungated: this is fire-and-forget telemetry posted from a
     * learner's browser, which has no token. It is write-only and returns
     * nothing, so it leaks nothing back to the caller.
     */
    const res = await fetch(`${base}/api/v1/diagnostics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "SNR_TOO_LOW", domain: "client", sessionId: "s1" }),
    });

    expect(res.status).toBe(204);
    expect(recordDiagnostic).toHaveBeenCalledTimes(1);
  });

  it("records a malformed body with a safe default rather than rejecting it", async () => {
    // A dropped diagnostic is a worse outcome than one recorded as UNKNOWN —
    // the trail is the deliverable.
    const res = await fetch(`${base}/api/v1/diagnostics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: 42, domain: [] }),
    });

    expect(res.status).toBe(204);
    const [record] = recordDiagnostic.mock.calls[0] as unknown as [{ code: string }];
    expect(record.code).toBe("UNKNOWN");
  });

  it("always answers 204, even when the write itself fails", async () => {
    // recordDiagnostic swallows its own failures; the endpoint must not wait
    // on it or report on it.
    recordDiagnostic.mockRejectedValueOnce(new Error("mongo down"));

    const res = await fetch(`${base}/api/v1/diagnostics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "TEST" }),
    });

    expect(res.status).toBe(204);
  });
});

/**
 * The per-learner filter.
 *
 * A narrowing endpoint has one failure mode worse than refusing: answering a
 * question about one person with everybody. So the property under test is not
 * only "a valid id filters" but "anything else is refused rather than
 * degraded into the unfiltered read".
 */
const LEARNER = "3f1a9c40-5b2e-4d7a-9f18-2c4b6e8a1d30";
const authed = { "x-diagnostics-token": TOKEN };

describe("the learner filter is gated exactly as the unfiltered read is", () => {
  it("refuses a lookup with no token, without touching the store", async () => {
    const res = await fetch(`${base}/api/v1/attempts?learnerId=${LEARNER}`);

    expect(res.status).toBe(401);
    // Deciding the 401 after the query would still be a read of that named
    // learner's records — declining to return them does not undo it.
    expect(listAttemptsFor).not.toHaveBeenCalled();
    expect(listDiagnosticsFor).not.toHaveBeenCalled();
  });

  it("refuses a lookup with a wrong token", async () => {
    const res = await fetch(`${base}/api/v1/diagnostics?learnerId=${LEARNER}`, {
      headers: { "x-diagnostics-token": "wrong" },
    });

    expect(res.status).toBe(401);
    expect(listDiagnosticsFor).not.toHaveBeenCalled();
  });

  it("refuses a lookup when no token is configured at all", async () => {
    delete process.env.DIAGNOSTICS_TOKEN;

    const res = await fetch(`${base}/api/v1/attempts?learnerId=${LEARNER}`, { headers: authed });

    expect(res.status).toBe(401);
    expect(listAttemptsFor).not.toHaveBeenCalled();
  });
});

describe("the learner filter", () => {
  it("routes a valid learner id to the per-learner query on both reads", async () => {
    const [a, d] = await Promise.all([
      fetch(`${base}/api/v1/attempts?learnerId=${LEARNER}`, { headers: authed }),
      fetch(`${base}/api/v1/diagnostics?learnerId=${LEARNER}`, { headers: authed }),
    ]);

    expect(a.status).toBe(200);
    expect(d.status).toBe(200);
    expect(listAttemptsFor).toHaveBeenCalledWith(LEARNER, 50);
    expect(listDiagnosticsFor).toHaveBeenCalledWith(LEARNER, 50);
    // And never the cross-everyone query, which would answer a question
    // about one learner with every learner.
    expect(listAttempts).not.toHaveBeenCalled();
    expect(listDiagnostics).not.toHaveBeenCalled();
  });

  it("leaves the unfiltered read exactly as it was when no learner is named", async () => {
    await fetch(`${base}/api/v1/attempts`, { headers: authed });

    expect(listAttempts).toHaveBeenCalledWith(50);
    expect(listAttemptsFor).not.toHaveBeenCalled();
  });

  it("still caps the limit under a filter", async () => {
    await fetch(`${base}/api/v1/attempts?learnerId=${LEARNER}&limit=100000`, { headers: authed });

    expect(listAttemptsFor).toHaveBeenCalledWith(LEARNER, 200);
  });

  it("refuses a repeated param rather than passing an array to the query", async () => {
    /**
     * `?learnerId=a&learnerId=b` parses to ["a","b"] on this Express version.
     * As a Mongo filter that matches nothing, so degrading to the unfiltered
     * read would answer with everyone and passing it through would answer
     * "no records" for a learner who has plenty. Both are wrong; 400 is not.
     */
    const res = await fetch(`${base}/api/v1/attempts?learnerId=${LEARNER}&learnerId=${LEARNER}`, {
      headers: authed,
    });

    expect(res.status).toBe(400);
    expect(listAttemptsFor).not.toHaveBeenCalled();
    expect(listAttempts).not.toHaveBeenCalled();
  });

  it("refuses bracket notation, whichever query parser is configured", async () => {
    /**
     * Inert under Express 5's default `simple` parser, which yields undefined
     * for this — but `app.set("query parser", "extended")` anywhere turns it
     * into { $ne: "zzz" }, and `{ learnerId: { $ne: "zzz" } }` is every
     * learner *but* one out of a narrowing endpoint. The guard is a predicate
     * on the value, so it does not depend on that setting.
     */
    const res = await fetch(`${base}/api/v1/diagnostics?learnerId[$ne]=zzz`, { headers: authed });

    // undefined under the default parser reads as "no filter", which is the
    // pre-existing unfiltered read and is correct; an object would be a 400.
    // Either way the operator never reaches a query.
    expect(listDiagnosticsFor).not.toHaveBeenCalled();
    if (res.status === 200) expect(listDiagnostics).toHaveBeenCalledWith(50);
    else expect(res.status).toBe(400);
  });

  it.each([
    ["a display name typed into the box", "Kimo"],
    ["a truncated paste", "3f1a9c40-5b2e-4d7a"],
    ["an empty value", ""],
    ["whitespace", "%20%20"],
    ["a uuid of the wrong version", "3f1a9c40-5b2e-1d7a-9f18-2c4b6e8a1d30"],
    ["a mongo operator as a plain string", "{'$ne':null}"],
  ])("refuses %s rather than falling back to every learner", async (_label, value) => {
    const res = await fetch(`${base}/api/v1/attempts?learnerId=${value}`, { headers: authed });

    expect(res.status).toBe(400);
    expect(listAttempts).not.toHaveBeenCalled();
    expect(listAttemptsFor).not.toHaveBeenCalled();
  });

  it("says what was wrong without echoing the value back", async () => {
    const res = await fetch(`${base}/api/v1/attempts?learnerId=Kimo`, { headers: authed });
    const body = (await res.json()) as { error: string };

    expect(body.error).toMatch(/learnerId/);
    // Reflecting the input into the response body is how a diagnostics
    // endpoint becomes an XSS vector for whoever renders the error.
    expect(body.error).not.toContain("Kimo");
  });

  it("carries the reasons that distinguish capture from provider through the filter", async () => {
    // The two indeterminate reasons the whole lookup exists to tell apart. If
    // `reason` does not survive the wire, the panel cannot classify anything.
    listAttemptsFor.mockResolvedValue([
      { result: { indeterminate: true, reason: "no speech recognised in the recording" } },
      { result: { indeterminate: true, reason: "provider cancelled (Error)" } },
    ] as never);

    const res = await fetch(`${base}/api/v1/attempts?learnerId=${LEARNER}`, { headers: authed });
    const body = (await res.json()) as { records: { result: { reason: string } }[] };

    expect(body.records.map((r) => r.result.reason)).toEqual([
      "no speech recognised in the recording",
      "provider cancelled (Error)",
    ]);
  });

  it("reports a store failure as 503 under a filter, as unfiltered", async () => {
    listDiagnosticsFor.mockRejectedValue(new Error("no mongo") as never);

    const res = await fetch(`${base}/api/v1/diagnostics?learnerId=${LEARNER}`, { headers: authed });

    expect(res.status).toBe(503);
    expect((await res.json()) as { error: string }).toEqual({ error: "diagnostics store unavailable" });
  });
});

describe("list limits", () => {
  it("caps the limit so one request cannot pull the whole collection", async () => {
    await fetch(`${base}/api/v1/attempts?limit=100000`, {
      headers: { "x-diagnostics-token": TOKEN },
    });

    const [limit] = listAttempts.mock.calls[0] as unknown as [number];
    expect(limit).toBeLessThanOrEqual(200);
  });

  it("falls back to a default for nonsense", async () => {
    for (const bad of ["abc", "-5", "0", ""]) {
      listAttempts.mockClear();
      await fetch(`${base}/api/v1/attempts?limit=${bad}`, {
        headers: { "x-diagnostics-token": TOKEN },
      });
      const [limit] = listAttempts.mock.calls[0] as unknown as [number];
      expect(limit, bad).toBe(50);
    }
  });
});
