/**
 * The thresholds, and the two ways a threshold rule goes wrong.
 *
 * The first is the one this repository has already paid for elsewhere: a rate
 * that is **null** means "not enough data", and reading it as zero makes a
 * server that has scored nothing look healthy. An alert that folds null into
 * `ok` sits quietly green through a total outage; one that folds it into
 * `firing` goes off on every restart. Neither is acceptable, so `unknown` is a
 * state of its own and most of this file is about proving it stays one.
 *
 * The second is noise. A rule that fires on the first indeterminate take out
 * of one call, or logs its current level on every scrape, gets muted by
 * whoever has to read it — and a muted alert is worse than an absent one,
 * because it looks like coverage. So: a minimum sample before a rate or a
 * percentile counts, and a log line on transition rather than on evaluation.
 *
 * Thresholds are read from the environment at module load, so every test that
 * depends on one imports a fresh module and then checks that the value it set
 * is the value the report was decided with. Setting an env var and asserting
 * on behaviour without that check has already passed four assertions here for
 * the wrong reason, against a module instance nobody was running.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MetricsSnapshot } from "./metrics.js";

interface LogLine {
  level: "info" | "warn";
  fields: Record<string, unknown>;
  message: string;
}

const logged: LogLine[] = [];

vi.mock("../logger.js", () => ({
  logger: {
    info: (fields: Record<string, unknown>, message: string) => logged.push({ level: "info", fields, message }),
    warn: (fields: Record<string, unknown>, message: string) => logged.push({ level: "warn", fields, message }),
    error: () => undefined,
    debug: () => undefined,
  },
}));

/** What getSpendReport resolves to, or throws, per test. */
let capUsedFraction: number | null = 0;
let spendFails = false;
let spendCalls = 0;

vi.mock("../spend.js", () => ({
  getSpendReport: () => {
    spendCalls += 1;
    if (spendFails) return Promise.reject(new Error("mongo unreachable"));
    return Promise.resolve({ capUsedFraction });
  },
}));

const THRESHOLD_KEYS = [
  "ALERT_INDETERMINATE_RATE",
  "ALERT_PROVIDER_P95_MS",
  "ALERT_SPEND_CAP_FRACTION",
  "ALERT_MIN_SCORING_CALLS",
] as const;

const ORIGINAL = Object.fromEntries(THRESHOLD_KEYS.map((key) => [key, process.env[key]]));

/**
 * A fresh module with `env` in force.
 *
 * Restoring by deletion rather than by assignment, because
 * `process.env.X = undefined` stores the string "undefined" — which parses as
 * NaN and would silently disable whichever threshold ran next.
 */
async function load(env: Partial<Record<(typeof THRESHOLD_KEYS)[number], string>> = {}) {
  vi.resetModules();
  for (const key of THRESHOLD_KEYS) {
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return await import("./alerts.js");
}

/** A snapshot of the real shape, with only the fields a rule reads set. */
function snapshotWith(over: {
  indeterminate?: number | null;
  scoringCalls?: number;
  p95?: number | null;
  samples?: number;
}): MetricsSnapshot {
  return {
    uptimeSeconds: 120,
    counters: over.scoringCalls === undefined ? {} : { "scoring.calls": over.scoringCalls },
    latency: {
      sampleSize: 1000,
      provider: {
        count: over.samples ?? 0,
        mean: null,
        p50: null,
        p95: over.p95 === undefined ? null : over.p95,
        p99: null,
      },
      total: { count: 0, mean: null, p50: null, p95: null, p99: null },
    },
    rates: {
      indeterminate: over.indeterminate === undefined ? null : over.indeterminate,
      miscue: null,
      error: null,
      syncPushFailure: null,
    },
  };
}

/** Inputs with nothing measurable, so a test only supplies what it is about. */
const NOTHING_KNOWN = {
  indeterminateRate: null,
  scoringCalls: 0,
  providerP95Ms: null,
  providerSamples: 0,
  capUsedFraction: null,
  fallbackPending: null,
};

function stateOf(report: { alerts: { name: string; state: string }[] }, name: string): string | undefined {
  return report.alerts.find((alert) => alert.name === name)?.state;
}

beforeEach(() => {
  logged.length = 0;
  capUsedFraction = 0;
  spendFails = false;
  spendCalls = 0;
});

afterEach(() => {
  for (const key of THRESHOLD_KEYS) {
    const value = ORIGINAL[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("null is unknown, never a breach and never ok", () => {
  it("reports every rule as unknown on a server that has done nothing", async () => {
    /**
     * The case the whole design turns on. Every input here is null or zero
     * because nothing has happened yet — not because everything is fine.
     */
    const { evaluateAlerts } = await load();

    const report = evaluateAlerts(NOTHING_KNOWN);

    expect(report.firing).toBe(false);
    expect(report.alerts.map((alert) => alert.state)).toEqual(["unknown", "unknown", "unknown", "unknown"]);
  });

  it("does not let unknown count towards firing", async () => {
    const { evaluateAlerts } = await load();

    const report = evaluateAlerts(NOTHING_KNOWN);

    // The distinction that makes `firing` usable as a single boolean: it means
    // "a rule broke", not "a rule could not be checked".
    expect(report.firing).toBe(false);
    expect(report.alerts.every((alert) => alert.state !== "ok")).toBe(true);
  });

  it("says why it cannot tell, so unknown is not mistaken for healthy", async () => {
    const { evaluateAlerts } = await load();

    const report = evaluateAlerts(NOTHING_KNOWN);

    for (const alert of report.alerts) expect(alert.detail.length).toBeGreaterThan(0);
    expect(report.alerts[0]?.detail).toContain("nothing has been scored");
  });

  it("logs nothing at all when every rule is unknown", async () => {
    // A quiet server must not produce four log lines a scrape, or per restart.
    const { evaluateAlerts } = await load();

    evaluateAlerts(NOTHING_KNOWN);

    expect(logged).toEqual([]);
  });
});

describe("indeterminate rate", () => {
  it("stays unknown below the sample floor even at 100%", async () => {
    /**
     * One indeterminate take out of one call is a 100% indeterminate rate.
     * Firing on it would mean an alarm on the first bad take after every
     * deploy, which is how a rule gets muted.
     */
    const { evaluateAlerts, alertThresholds } = await load();

    const report = evaluateAlerts({ ...NOTHING_KNOWN, indeterminateRate: 1, scoringCalls: 1 });

    expect(alertThresholds.minScoringCalls).toBe(50);
    expect(stateOf(report, "indeterminateRate")).toBe("unknown");
    expect(report.firing).toBe(false);
  });

  it("fires above the baseline once there are enough calls", async () => {
    const { evaluateAlerts } = await load();

    const report = evaluateAlerts({ ...NOTHING_KNOWN, indeterminateRate: 0.22, scoringCalls: 200 });

    expect(stateOf(report, "indeterminateRate")).toBe("firing");
    expect(report.firing).toBe(true);
  });

  it("stays ok at the measured 7.2% baseline", async () => {
    // The threshold sits above the baseline on purpose: at n=139 the standard
    // error on 7.2% is about 2.2 points, so a rule set at baseline would fire
    // on noise.
    const { evaluateAlerts } = await load();

    const report = evaluateAlerts({ ...NOTHING_KNOWN, indeterminateRate: 0.072, scoringCalls: 139 });

    expect(stateOf(report, "indeterminateRate")).toBe("ok");
  });

  it("treats a genuine zero as ok rather than unknown", async () => {
    // Different from null: this server has scored 200 calls and none of them
    // was indeterminate, which is real information.
    const { evaluateAlerts } = await load();

    const report = evaluateAlerts({ ...NOTHING_KNOWN, indeterminateRate: 0, scoringCalls: 200 });

    expect(stateOf(report, "indeterminateRate")).toBe("ok");
  });

  it("decides with the threshold it reports, and reports the one it was configured with", async () => {
    /**
     * The same-instance proof. A threshold set in the environment and then
     * asserted on only through behaviour can be satisfied by a module the test
     * configured but is not running. Here the report itself carries the value
     * used, so the assertion and the decision cannot come apart: 0.3 is ok
     * under a 0.4 rule and firing under the default 0.15.
     */
    const { evaluateAlerts, alertThresholds } = await load({ ALERT_INDETERMINATE_RATE: "0.4" });

    const report = evaluateAlerts({ ...NOTHING_KNOWN, indeterminateRate: 0.3, scoringCalls: 200 });
    const alert = report.alerts.find((a) => a.name === "indeterminateRate");

    expect(alertThresholds.indeterminateRate).toBe(0.4);
    expect(alert?.threshold).toBe(0.4);
    expect(alert?.state).toBe("ok");
  });

  it("refuses a zero threshold rather than firing on everything", async () => {
    // env.ts's rule: a present but unusable value falls back to the documented
    // default and says so. A threshold of 0 would make every rate a breach.
    const { alertThresholds } = await load({ ALERT_INDETERMINATE_RATE: "0" });

    expect(alertThresholds.indeterminateRate).toBe(0.15);
  });
});

describe("provider latency", () => {
  it("stays unknown until a p95 is a percentile rather than the slowest of three", async () => {
    const { evaluateAlerts } = await load();

    const report = evaluateAlerts({ ...NOTHING_KNOWN, providerP95Ms: 9000, providerSamples: 3 });

    expect(stateOf(report, "providerLatencyP95")).toBe("unknown");
    expect(report.firing).toBe(false);
  });

  it("fires on a breach with enough samples", async () => {
    const { evaluateAlerts, alertThresholds } = await load();

    const report = evaluateAlerts({ ...NOTHING_KNOWN, providerP95Ms: 6200, providerSamples: 400 });

    expect(alertThresholds.providerLatencyP95Ms).toBe(4_000);
    expect(stateOf(report, "providerLatencyP95")).toBe("firing");
  });

  it("stays ok on a normal p95", async () => {
    const { evaluateAlerts } = await load();

    const report = evaluateAlerts({ ...NOTHING_KNOWN, providerP95Ms: 1300, providerSamples: 400 });

    expect(stateOf(report, "providerLatencyP95")).toBe("ok");
  });

  it("uses the configured line, proven by the threshold in the report", async () => {
    const { evaluateAlerts, alertThresholds } = await load({ ALERT_PROVIDER_P95_MS: "1200" });

    const report = evaluateAlerts({ ...NOTHING_KNOWN, providerP95Ms: 1300, providerSamples: 400 });
    const alert = report.alerts.find((a) => a.name === "providerLatencyP95");

    expect(alertThresholds.providerLatencyP95Ms).toBe(1200);
    expect(alert?.threshold).toBe(1200);
    expect(alert?.state).toBe("firing");
  });
});

describe("daily spend", () => {
  it("fires at 80% of the cap, before the cap starts refusing calls", async () => {
    const { evaluateAlerts, alertThresholds } = await load();

    const report = evaluateAlerts({ ...NOTHING_KNOWN, capUsedFraction: 0.8 });

    expect(alertThresholds.spendCapFraction).toBe(0.8);
    expect(stateOf(report, "dailySpend")).toBe("firing");
  });

  it("stays ok under the fraction", async () => {
    const { evaluateAlerts } = await load();

    expect(stateOf(evaluateAlerts({ ...NOTHING_KNOWN, capUsedFraction: 0.79 }), "dailySpend")).toBe("ok");
  });

  it("is unknown, not ok, when spend cannot be read", async () => {
    // An unreadable cap is not an unspent one.
    const { evaluateAlerts } = await load();

    expect(stateOf(evaluateAlerts({ ...NOTHING_KNOWN, capUsedFraction: null }), "dailySpend")).toBe("unknown");
  });
});

describe("fallbackPending", () => {
  it("fires on a single pending record, because it means an outage already happened", async () => {
    /**
     * The failover to a local file is deliberately silent so that no learner's
     * request ever fails over a log write — which makes this gauge the only
     * outward sign the Mongo write failed at all.
     */
    const { evaluateAlerts } = await load();

    const report = evaluateAlerts({ ...NOTHING_KNOWN, fallbackPending: 1 });
    const alert = report.alerts.find((a) => a.name === "fallbackPending");

    expect(alert?.state).toBe("firing");
    expect(alert?.detail).toContain("replay-fallback");
  });

  it("is ok at zero", async () => {
    const { evaluateAlerts } = await load();

    expect(stateOf(evaluateAlerts({ ...NOTHING_KNOWN, fallbackPending: 0 }), "fallbackPending")).toBe("ok");
  });

  it("is unknown when the directory could not be read", async () => {
    // A directory that cannot be read is not evidence of an empty one.
    const { evaluateAlerts } = await load();

    expect(stateOf(evaluateAlerts({ ...NOTHING_KNOWN, fallbackPending: null }), "fallbackPending")).toBe("unknown");
  });
});

describe("logging on transition, not on evaluation", () => {
  it("logs once when a rule starts firing and stays quiet while it keeps firing", async () => {
    /**
     * The property that decides whether the log is readable. `/metrics` is
     * scraped on a timer, so a line per evaluation is a line per scrape.
     */
    const { evaluateAlerts } = await load();
    const breaching = { ...NOTHING_KNOWN, fallbackPending: 4 };

    evaluateAlerts(breaching);
    evaluateAlerts(breaching);
    evaluateAlerts(breaching);

    expect(logged).toHaveLength(1);
    expect(logged[0]?.level).toBe("warn");
    expect(logged[0]?.message).toContain("FIRING");
  });

  it("logs a resolution when the breach clears", async () => {
    const { evaluateAlerts } = await load();

    evaluateAlerts({ ...NOTHING_KNOWN, fallbackPending: 4 });
    evaluateAlerts({ ...NOTHING_KNOWN, fallbackPending: 0 });
    evaluateAlerts({ ...NOTHING_KNOWN, fallbackPending: 0 });

    expect(logged).toHaveLength(2);
    expect(logged[1]?.level).toBe("info");
    expect(logged[1]?.message).toContain("resolved");
  });

  it("does not call a lost signal a resolution", async () => {
    /**
     * A rule that stopped being measurable while it was firing has not
     * recovered — nobody knows what it is doing. Logging that as "resolved"
     * would be the more comfortable lie, and the one that closes an incident
     * that is still open.
     */
    const { evaluateAlerts } = await load();

    evaluateAlerts({ ...NOTHING_KNOWN, fallbackPending: 4 });
    evaluateAlerts({ ...NOTHING_KNOWN, fallbackPending: null });

    expect(logged).toHaveLength(2);
    expect(logged[1]?.level).toBe("warn");
    expect(logged[1]?.message).toContain("no longer be evaluated");
    expect(logged[1]?.message).not.toContain("resolved");
  });

  it("names the state it came from, so a log line is readable alone", async () => {
    const { evaluateAlerts } = await load();

    evaluateAlerts({ ...NOTHING_KNOWN, fallbackPending: 0 });
    evaluateAlerts({ ...NOTHING_KNOWN, fallbackPending: 2 });

    expect(logged.at(-1)?.fields).toMatchObject({
      alert: "fallbackPending",
      state: "firing",
      from: "ok",
      value: 2,
      threshold: 0,
    });
  });

  it("holds `since` steady while the state holds, and moves it on a change", async () => {
    // `since` answers "how long has this been true", which is the first thing
    // anyone asks. A timestamp refreshed per evaluation would answer "when was
    // this last scraped" instead, and look identical.
    const { evaluateAlerts } = await load();
    const first = new Date("2026-09-09T10:00:00.000Z");
    const later = new Date("2026-09-09T10:05:00.000Z");
    const changed = new Date("2026-09-09T10:09:00.000Z");

    const opened = evaluateAlerts({ ...NOTHING_KNOWN, fallbackPending: 3 }, first);
    const held = evaluateAlerts({ ...NOTHING_KNOWN, fallbackPending: 3 }, later);
    const cleared = evaluateAlerts({ ...NOTHING_KNOWN, fallbackPending: 0 }, changed);

    expect(opened.alerts.find((a) => a.name === "fallbackPending")?.since).toBe(first.toISOString());
    expect(held.alerts.find((a) => a.name === "fallbackPending")?.since).toBe(first.toISOString());
    expect(cleared.alerts.find((a) => a.name === "fallbackPending")?.since).toBe(changed.toISOString());
  });

  it("keeps each rule's transitions independent", async () => {
    const { evaluateAlerts } = await load();

    evaluateAlerts({ ...NOTHING_KNOWN, fallbackPending: 1 });
    logged.length = 0;
    evaluateAlerts({ ...NOTHING_KNOWN, fallbackPending: 1, capUsedFraction: 0.95 });

    // Only the spend rule changed; the fallback rule was already firing.
    expect(logged).toHaveLength(1);
    expect(logged[0]?.fields.alert).toBe("dailySpend");
  });

  it("forgets its history when reset, so one test cannot decide the next", async () => {
    const { evaluateAlerts, resetAlerts } = await load();

    evaluateAlerts({ ...NOTHING_KNOWN, fallbackPending: 1 });
    resetAlerts();
    logged.length = 0;
    evaluateAlerts({ ...NOTHING_KNOWN, fallbackPending: 1 });

    expect(logged).toHaveLength(1);
  });
});

describe("collectAlerts over a real snapshot", () => {
  it("reads the rate, the percentile and the call count out of the snapshot", async () => {
    const { collectAlerts } = await load();

    const report = await collectAlerts(
      snapshotWith({ indeterminate: 0.2, scoringCalls: 200, p95: 6000, samples: 200 }),
      { attempts: 0, diagnostics: 0 },
    );

    expect(stateOf(report, "indeterminateRate")).toBe("firing");
    expect(stateOf(report, "providerLatencyP95")).toBe("firing");
    expect(stateOf(report, "fallbackPending")).toBe("ok");
    expect(report.firing).toBe(true);
  });

  it("treats an absent scoring.calls counter as zero calls, which is unknown", async () => {
    /**
     * metrics.ts starts with no counters rather than a row of zeroes, so the
     * key is genuinely missing on a fresh process. Zero *calls* is a fact;
     * a zero *rate* would not be, which is why one is defaulted and the other
     * never is.
     */
    const { collectAlerts } = await load();

    const report = await collectAlerts(snapshotWith({}), { attempts: 0, diagnostics: 0 });

    expect(stateOf(report, "indeterminateRate")).toBe("unknown");
  });

  it("sums the fallback collections rather than watching only one", async () => {
    // A backlog of diagnostics with no pending attempts is still a Mongo write
    // that failed.
    const { collectAlerts } = await load();

    const report = await collectAlerts(snapshotWith({}), { attempts: 0, diagnostics: 2 });
    const alert = report.alerts.find((a) => a.name === "fallbackPending");

    expect(alert?.state).toBe("firing");
    expect(alert?.value).toBe(2);
  });

  it("passes an unreadable fallback directory through as unknown", async () => {
    const { collectAlerts } = await load();

    const report = await collectAlerts(snapshotWith({}), null);

    expect(stateOf(report, "fallbackPending")).toBe("unknown");
  });

  it("takes the cap fraction from the spend report", async () => {
    const { collectAlerts } = await load();
    capUsedFraction = 0.93;

    const report = await collectAlerts(snapshotWith({}), { attempts: 0, diagnostics: 0 });
    const alert = report.alerts.find((a) => a.name === "dailySpend");

    expect(alert?.state).toBe("firing");
    expect(alert?.value).toBe(0.93);
  });

  it("reports unknown rather than rejecting when the spend read fails", async () => {
    /**
     * `/metrics` is the surface that would have reported the failure. A
     * rejected promise there turns a degraded answer into no answer.
     */
    const { collectAlerts } = await load();
    spendFails = true;

    const report = await collectAlerts(snapshotWith({}), { attempts: 0, diagnostics: 0 });

    expect(stateOf(report, "dailySpend")).toBe("unknown");
  });

  it("reuses one spend read across scrapes rather than scanning per request", async () => {
    // The spend report is a collection scan over attempts, and /metrics is hit
    // on a timer. Evaluating it per scrape would put a full scan on a schedule.
    const { collectAlerts } = await load();

    await collectAlerts(snapshotWith({}), { attempts: 0, diagnostics: 0 });
    await collectAlerts(snapshotWith({}), { attempts: 0, diagnostics: 0 });
    await collectAlerts(snapshotWith({}), { attempts: 0, diagnostics: 0 });

    expect(spendCalls).toBe(1);
  });

  it("wires to the live metrics module, not only to a hand-built snapshot", async () => {
    /**
     * The synthetic snapshots above pin the arithmetic; this pins the field
     * names. A rename in metrics.ts that this file did not follow would leave
     * every test above passing and the running rules reading undefined.
     */
    vi.resetModules();
    const metrics = await import("./metrics.js");
    const { collectAlerts } = await import("./alerts.js");
    metrics.resetMetrics();

    metrics.increment("scoring.calls", 60);
    metrics.increment("scoring.indeterminate", 15);
    for (let i = 0; i < 60; i += 1) metrics.observeScoringLatency(120, 200);

    const report = await collectAlerts(metrics.snapshot(), { attempts: 0, diagnostics: 0 });
    const rate = report.alerts.find((a) => a.name === "indeterminateRate");
    const latency = report.alerts.find((a) => a.name === "providerLatencyP95");

    expect(rate?.value).toBe(0.25);
    expect(rate?.state).toBe("firing");
    expect(latency?.value).toBe(120);
    expect(latency?.state).toBe("ok");
  });
});
