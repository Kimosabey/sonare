/**
 * Liveness, readiness, the metrics behind them, and why conflating any two of
 * the three breaks a deployment.
 *
 * The rule this file exists to hold: **`/healthz` must stay true while the
 * database is down.** An orchestrator that kills a container on a failing
 * liveness probe turns one Mongo outage into a restart loop across every
 * instance — and scoring genuinely still works during that outage, because
 * attempts fail over to a local file. Readiness is the probe that should fail
 * there: it takes an instance out of rotation without killing it.
 *
 * The third question is "should somebody look", and `/metrics` answers it with
 * `alerts`. It is deliberately not on `/readyz`: a high indeterminate rate, a
 * slow provider, an 80%-spent cap and a fallback backlog are all worth a
 * person's attention and none of them is a reason to stop sending traffic to a
 * process that is still scoring — three of the four would be made *worse* by
 * shifting that traffic onto whatever instances remain.
 *
 * Driven through real Express, because what is being tested is a status code
 * an orchestrator reads without parsing a body.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

let dbFails = false;
let pingFails = false;
let providerFails = false;
/** What the spend aggregation returns, so the cap-fraction rule can be driven. */
let todayCalls = 0;

vi.mock("../db.js", () => ({
  getDb: () => {
    if (dbFails) return Promise.reject(new Error("no connection"));
    return Promise.resolve({
      command: () => (pingFails ? Promise.reject(new Error("not answering")) : Promise.resolve({ ok: 1 })),
      collection: () => ({
        createIndex: () => Promise.resolve("ok"),
        // The $facet shape server/spend.ts actually reads. Present so the
        // daily-spend alert is exercised through the real aggregation code
        // rather than only through its failure path.
        aggregate: () => ({
          toArray: () =>
            Promise.resolve([
              {
                allTime: [{ calls: todayCalls, audioSeconds: 0, billableSeconds: 0 }],
                today: [{ calls: todayCalls, audioSeconds: 0, billableSeconds: 0 }],
              },
            ]),
        }),
      }),
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

/**
 * An empty directory for the fallback log to be counted in.
 *
 * Pinned rather than left at `process.cwd()/data`, because `fallbackPending`
 * is now an alert input: a developer who has run the app through a real Mongo
 * outage would have records on disk, and these assertions would then depend on
 * their machine's history rather than on the code.
 */
const EMPTY_FALLBACK_DIR = mkdtempSync(join(tmpdir(), "sonare-health-"));

let server: Server;
let base: string;

/**
 * Boots the router with `env` in force.
 *
 * Every module is re-imported after `vi.resetModules()`, so the thresholds and
 * paths read at module load are read by the instances this server is actually
 * running. Setting an env var without that re-import configures a *different*
 * module instance than the app under test — which has passed assertions here
 * for the wrong reason before, so the alert tests below assert on the
 * threshold echoed in the response rather than on behaviour alone.
 */
async function start(
  diagnosticsToken: string | null = TOKEN,
  env: Record<string, string> = {},
): Promise<void> {
  vi.resetModules();
  if (diagnosticsToken === null) delete process.env.DIAGNOSTICS_TOKEN;
  else process.env.DIAGNOSTICS_TOKEN = diagnosticsToken;
  process.env.LEARNER_TOKEN_SECRET = "secret-for-tests";
  process.env.FALLBACK_DIR = EMPTY_FALLBACK_DIR;
  for (const [key, value] of Object.entries(env)) process.env[key] = value;

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

/** Restarts the server under different configuration, mid-test. */
async function restart(diagnosticsToken: string | null, env: Record<string, string> = {}): Promise<void> {
  await new Promise<void>((done) => server.close(() => done()));
  await start(diagnosticsToken, env);
}

interface AlertBody {
  firing: boolean;
  alerts: { name: string; state: string; value: number | null; threshold: number; detail: string }[];
}

async function alertsFrom(): Promise<AlertBody> {
  const res = await fetch(`${base}/metrics`, { headers: { "x-diagnostics-token": TOKEN } });
  return ((await res.json()) as { alerts: AlertBody }).alerts;
}

/** Cleared after every test, so no test inherits another's configuration. */
const ENV_KEYS = [
  "ALERT_INDETERMINATE_RATE",
  "ALERT_PROVIDER_P95_MS",
  "ALERT_SPEND_CAP_FRACTION",
  "ALERT_MIN_SCORING_CALLS",
  "MAX_DAILY_SCORING_CALLS",
];

beforeEach(async () => {
  dbFails = false;
  pingFails = false;
  providerFails = false;
  todayCalls = 0;
  await start();
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  delete process.env.DIAGNOSTICS_TOKEN;
  delete process.env.LEARNER_TOKEN_SECRET;
  delete process.env.FALLBACK_DIR;
  // Deleted rather than assigned back: `process.env.X = undefined` stores the
  // string "undefined", which parses as NaN and would disable a threshold in
  // whichever test ran next.
  for (const key of ENV_KEYS) delete process.env[key];
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
    await restart(null);

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
    await restart(null);

    expect((await fetch(`${base}/metrics`, { headers: { "x-diagnostics-token": TOKEN } })).status).toBe(401);
  });
});

describe("alerts on the metrics surface", () => {
  it("carries all four rules and one boolean over them", async () => {
    /**
     * The point of the boolean: an operator's smallest possible check becomes
     * reading one field instead of judging four numbers against thresholds
     * they would have to remember.
     */
    const alerts = await alertsFrom();

    expect(alerts.alerts.map((alert) => alert.name)).toEqual([
      "indeterminateRate",
      "providerLatencyP95",
      "dailySpend",
      "fallbackPending",
    ]);
    expect(typeof alerts.firing).toBe("boolean");
  });

  it("does not fire the rate rule on four calls, even at 25%", async () => {
    /**
     * The honesty rule, end to end. This server has scored four calls and one
     * was indeterminate — 25%, well over the 15% line — and the rule reads
     * `unknown`, because four calls is not a rate. Firing here would mean an
     * alarm on the first bad take after every deploy.
     */
    const alerts = await alertsFrom();
    const rate = alerts.alerts.find((alert) => alert.name === "indeterminateRate");

    expect(rate?.state).toBe("unknown");
    expect(rate?.detail).toContain("50 calls");
    expect(alerts.firing).toBe(false);
  });

  it("uses the thresholds this process was configured with", async () => {
    /**
     * The same-instance proof. Configuring a threshold and then asserting only
     * on behaviour can be satisfied by a module instance the test set up and
     * the server never loaded — that has happened in this repository. So the
     * response carries the threshold it decided with, and both are checked:
     * the same 25% rate that read `unknown` above fires under a floor of two
     * calls and a line of 20%.
     */
    await restart(TOKEN, { ALERT_MIN_SCORING_CALLS: "2", ALERT_INDETERMINATE_RATE: "0.2" });

    const alerts = await alertsFrom();
    const rate = alerts.alerts.find((alert) => alert.name === "indeterminateRate");

    expect(rate?.threshold).toBe(0.2);
    expect(rate?.value).toBe(0.25);
    expect(rate?.state).toBe("firing");
    expect(alerts.firing).toBe(true);
  });

  it("judges the same snapshot it serves", async () => {
    // Alerts computed from a second read of the counters could disagree with
    // the figures printed beside them, which is a payload nobody can reason
    // from.
    const res = await fetch(`${base}/metrics`, { headers: { "x-diagnostics-token": TOKEN } });
    const body = (await res.json()) as { rates: { indeterminate: number | null }; alerts: AlertBody };

    expect(body.rates.indeterminate).toBe(0.25);
    expect(body.alerts.alerts.find((alert) => alert.name === "indeterminateRate")?.value).toBe(0.25);
  });

  it("fires the spend rule at 80% of the daily cap", async () => {
    // Before the cap, calls still succeed and nothing announces the approach.
    // After it, the failure announces itself.
    await restart(TOKEN, { MAX_DAILY_SCORING_CALLS: "10" });
    todayCalls = 9;

    const alerts = await alertsFrom();
    const spend = alerts.alerts.find((alert) => alert.name === "dailySpend");

    expect(spend?.state).toBe("firing");
    expect(spend?.value).toBe(0.9);
  });

  it("still answers, with spend unknown, while Mongo is down", async () => {
    /**
     * The spend figure comes from an aggregation, so it is the one input that
     * can be unavailable. A metrics endpoint that 500s during a database
     * outage is one that goes dark exactly when it is being read — and an
     * unreadable cap is `unknown`, not an unspent one.
     */
    dbFails = true;

    const res = await fetch(`${base}/metrics`, { headers: { "x-diagnostics-token": TOKEN } });
    const body = (await res.json()) as { counters: Record<string, number>; alerts: AlertBody };

    expect(res.status).toBe(200);
    expect(body.counters["scoring.calls"]).toBe(4);
    expect(body.alerts.alerts.find((alert) => alert.name === "dailySpend")?.state).toBe("unknown");
    expect(body.alerts.firing).toBe(false);
  });

  it("reads the fallback backlog off disk into the rule", async () => {
    // Zero here is a real answer rather than an unknown one: the directory was
    // read and holds nothing.
    const alerts = await alertsFrom();
    const fallback = alerts.alerts.find((alert) => alert.name === "fallbackPending");

    expect(fallback?.state).toBe("ok");
    expect(fallback?.value).toBe(0);
  });

  it("keeps a firing alert from taking the instance out of rotation", async () => {
    /**
     * The boundary between the three endpoints. Readiness answers "should
     * traffic come here" and alerts answer "should somebody look" — and if a
     * breach made an instance unready, an 80%-spent cap or a slow provider
     * would move its traffic onto whatever instances remain, which makes three
     * of the four rules worse rather than better.
     */
    await restart(TOKEN, { MAX_DAILY_SCORING_CALLS: "10" });
    todayCalls = 10;

    expect((await alertsFrom()).firing).toBe(true);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });
});
