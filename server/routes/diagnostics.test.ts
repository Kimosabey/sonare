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
const recordDiagnostic = vi.fn(() => Promise.resolve());

vi.mock("../diagnostics.js", () => ({
  listDiagnostics: (...a: unknown[]) => listDiagnostics(...(a as [])),
  recordDiagnostic: (...a: unknown[]) => recordDiagnostic(...(a as [])),
}));
vi.mock("../attempts.js", () => ({ listAttempts: (...a: unknown[]) => listAttempts(...(a as [])) }));
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
