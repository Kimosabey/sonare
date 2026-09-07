/**
 * Liveness, readiness, and why conflating them breaks a deployment.
 *
 * The rule this file exists to hold: **`/healthz` must stay true while the
 * database is down.** An orchestrator that kills a container on a failing
 * liveness probe turns one Mongo outage into a restart loop across every
 * instance — and scoring genuinely still works during that outage, because
 * attempts fail over to a local file. Readiness is the probe that should fail
 * there: it takes an instance out of rotation without killing it.
 *
 * Driven through real Express, because what is being tested is a status code
 * an orchestrator reads without parsing a body.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

let dbFails = false;
let pingFails = false;
let providerFails = false;

vi.mock("../db.js", () => ({
  getDb: () => {
    if (dbFails) return Promise.reject(new Error("no connection"));
    return Promise.resolve({
      command: () => (pingFails ? Promise.reject(new Error("not answering")) : Promise.resolve({ ok: 1 })),
      collection: () => ({ createIndex: () => Promise.resolve("ok") }),
    });
  },
}));

vi.mock("../services/index.js", () => ({
  getScoringProvider: () => {
    if (providerFails) throw new Error("MISCONFIGURED");
    return { name: "azure", score: () => Promise.resolve({}) };
  },
}));

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const TOKEN = "diagnostics-token-for-tests";

let server: Server;
let base: string;

async function start(diagnosticsToken: string | null = TOKEN): Promise<void> {
  vi.resetModules();
  if (diagnosticsToken === null) delete process.env.DIAGNOSTICS_TOKEN;
  else process.env.DIAGNOSTICS_TOKEN = diagnosticsToken;
  process.env.LEARNER_TOKEN_SECRET = "secret-for-tests";

  const express = (await import("express")).default;
  const { healthRouter } = await import("./health.js");
  const { increment, resetMetrics, observeScoringLatency } = await import("../infra/metrics.js");
  resetMetrics();
  increment("scoring.calls", 4);
  increment("scoring.indeterminate", 1);
  observeScoringLatency(800, 900);

  const app = express();
  app.use(healthRouter);
  await new Promise<void>((ready) => {
    server = app.listen(0, () => ready());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  dbFails = false;
  pingFails = false;
  providerFails = false;
  await start();
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  delete process.env.DIAGNOSTICS_TOKEN;
  delete process.env.LEARNER_TOKEN_SECRET;
  vi.clearAllMocks();
});

describe("liveness", () => {
  it("is alive", async () => {
    const res = await fetch(`${base}/healthz`);

    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
  });

  it("stays alive while the database is down", async () => {
    /**
     * The whole point of separating the two probes. Killing containers because
     * Mongo is unreachable turns one outage into a restart loop across every
     * instance — and scoring still works, because attempts fail over to a
     * local file.
     */
    dbFails = true;

    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it("stays alive with no provider configured", async () => {
    providerFails = true;

    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it("needs no token, because a 401 reads as a dead process", async () => {
    await new Promise<void>((done) => server.close(() => done()));
    await start(null);

    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });
});

describe("readiness", () => {
  it("is ready when the database answers and a provider is configured", async () => {
    const res = await fetch(`${base}/readyz`);

    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, boolean>).toMatchObject({
      ready: true,
      database: true,
      provider: true,
    });
  });

  it("is not ready when the database is unreachable", async () => {
    dbFails = true;

    const res = await fetch(`${base}/readyz`);

    expect(res.status).toBe(503);
    expect((await res.json()) as Record<string, boolean>).toMatchObject({ ready: false, database: false });
  });

  it("is not ready when the database connects but does not answer", async () => {
    /**
     * Pinged rather than trusted. `getDb()` caches its connection, so a
     * resolved promise only proves it connected once — a Mongo that has since
     * stopped responding would still look ready.
     */
    pingFails = true;

    expect((await fetch(`${base}/readyz`)).status).toBe(503);
  });

  it("is not ready with no scoring provider", async () => {
    providerFails = true;

    const res = await fetch(`${base}/readyz`);

    expect(res.status).toBe(503);
    expect((await res.json()) as Record<string, boolean>).toMatchObject({ provider: false });
  });

  it("answers with a status code, not a flag inside a 200", async () => {
    // So an orchestrator reading only the code gets the right answer without
    // parsing a body.
    dbFails = true;

    expect((await fetch(`${base}/readyz`)).ok).toBe(false);
  });

  it("reports identity without letting it block traffic", async () => {
    /**
     * Scoring works without identity — a learner who never registered must
     * still be able to practise — so refusing traffic over it would take the
     * product down for a feature that is optional by design.
     */
    await new Promise<void>((done) => server.close(() => done()));
    vi.resetModules();
    delete process.env.LEARNER_TOKEN_SECRET;
    process.env.DIAGNOSTICS_TOKEN = TOKEN;

    const express = (await import("express")).default;
    const { healthRouter } = await import("./health.js");
    const app = express();
    app.use(healthRouter);
    await new Promise<void>((ready) => {
      server = app.listen(0, () => ready());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const res = await fetch(`${base}/readyz`);

    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, boolean>).toMatchObject({ ready: true, identity: false });
  });
});

describe("metrics", () => {
  it("refuses without the token", async () => {
    // The counters describe usage volumes and failure rates. Not learner
    // content, and not public either.
    expect((await fetch(`${base}/metrics`)).status).toBe(401);
  });

  it("refuses a wrong token", async () => {
    const res = await fetch(`${base}/metrics`, { headers: { "x-diagnostics-token": "guess" } });

    expect(res.status).toBe(401);
  });

  it("serves the snapshot with the token", async () => {
    const res = await fetch(`${base}/metrics`, { headers: { "x-diagnostics-token": TOKEN } });
    const body = (await res.json()) as {
      counters: Record<string, number>;
      rates: { indeterminate: number | null };
      latency: { provider: { p50: number | null } };
    };

    expect(res.status).toBe(200);
    expect(body.counters["scoring.calls"]).toBe(4);
    expect(body.rates.indeterminate).toBe(0.25);
    expect(body.latency.provider.p50).toBe(800);
  });

  it("is closed when no token is configured, not open", async () => {
    // The rule DIAGNOSTICS_TOKEN already establishes: there is no "unset means
    // open", because that is how an internal endpoint becomes a public one.
    await new Promise<void>((done) => server.close(() => done()));
    await start(null);

    expect((await fetch(`${base}/metrics`, { headers: { "x-diagnostics-token": TOKEN } })).status).toBe(401);
  });
});
