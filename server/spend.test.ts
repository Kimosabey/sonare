/**
 * Arithmetic that turns into money, which had no tests.
 *
 * The one that matters is the difference between audio *sent* and audio
 * *billed*: Azure charges per second rounded up per request, so summing raw
 * durations understates the bill — and understates it worst on short clips,
 * which is exactly where the fixture decision lives. 80 sub-second words send
 * roughly 44 seconds and are billed 80.
 *
 * `getDb` is mocked so the aggregation's *result* can be fixed and the maths
 * around it examined. The rate is read from the environment at module load, so
 * each test imports a fresh module rather than trying to mutate a constant.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface RawWindow {
  calls?: number;
  audioSeconds?: number;
  billableSeconds?: number;
  indeterminateCalls?: number;
  indeterminateSeconds?: number;
}

/** What the $facet pipeline returns, so the shape stays honest. */
function facet(allTime: RawWindow, today: RawWindow) {
  return [{ allTime: [allTime], today: [today] }];
}

let aggregateResult: unknown[] = [];

vi.mock("./db.js", () => ({
  getDb: () =>
    Promise.resolve({
      collection: () => ({
        aggregate: () => ({ toArray: () => Promise.resolve(aggregateResult) }),
      }),
    }),
}));

async function loadWith(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return (await import("./spend.js")).getSpendReport;
}

const ORIGINAL = {
  rate: process.env.AZURE_SPEECH_RATE_PER_AUDIO_HOUR,
  currency: process.env.AZURE_SPEECH_RATE_CURRENCY,
  cap: process.env.MAX_DAILY_SCORING_CALLS,
};

beforeEach(() => {
  aggregateResult = [];
});

/**
 * Restored by deleting, not by assigning back. `process.env.X = undefined`
 * stores the *string* "undefined" — which is truthy, so the module under test
 * would read a rate of `Number("undefined")` and produce NaN costs in whatever
 * test ran next. This file hit exactly that: a test that passed alone failed
 * in sequence.
 */
function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  restore("AZURE_SPEECH_RATE_PER_AUDIO_HOUR", ORIGINAL.rate);
  restore("AZURE_SPEECH_RATE_CURRENCY", ORIGINAL.currency);
  restore("MAX_DAILY_SCORING_CALLS", ORIGINAL.cap);
  vi.restoreAllMocks();
});

describe("getSpendReport — cost comes off billable seconds", () => {
  it("charges the rounded-up seconds, not the audio actually sent", async () => {
    // The real numbers from this repo: 61 calls sent 285.2s and are billed 313s
    // because each request rounds up to a whole second.
    aggregateResult = facet(
      { calls: 61, audioSeconds: 285.2, billableSeconds: 313, indeterminateCalls: 7, indeterminateSeconds: 32 },
      { calls: 61, audioSeconds: 285.2, billableSeconds: 313, indeterminateCalls: 7, indeterminateSeconds: 32 },
    );
    const getSpendReport = await loadWith({ AZURE_SPEECH_RATE_PER_AUDIO_HOUR: "1.00" });

    const report = await getSpendReport();

    // 313 / 3600 x $1.00
    expect(report.allTime.cost).toBeCloseTo(0.0869, 4);
    // Not the 0.0792 that summing raw duration would give.
    expect(report.allTime.cost).not.toBeCloseTo(285.2 / 3600, 4);
    expect(report.allTime.billableSeconds).toBe(313);
    expect(report.allTime.audioSeconds).toBe(285.2);
  });

  it("prices the calls that bought no learner feedback separately", async () => {
    // An indeterminate result is the honest answer and is billed identically —
    // which makes it the figure to watch when a run costs more than expected.
    aggregateResult = facet(
      { calls: 10, audioSeconds: 40, billableSeconds: 45, indeterminateCalls: 3, indeterminateSeconds: 18 },
      { calls: 0 },
    );
    const getSpendReport = await loadWith({ AZURE_SPEECH_RATE_PER_AUDIO_HOUR: "1.00" });

    const report = await getSpendReport();

    expect(report.allTime.indeterminateCalls).toBe(3);
    expect(report.allTime.indeterminateCost).toBeCloseTo(18 / 3600, 5);
  });

  it("scales with the configured rate, including the prosody add-on case", async () => {
    aggregateResult = facet({ calls: 1, audioSeconds: 3600, billableSeconds: 3600 }, { calls: 0 });
    const getSpendReport = await loadWith({ AZURE_SPEECH_RATE_PER_AUDIO_HOUR: "1.30" });

    const report = await getSpendReport();

    // One audio hour at the rate that applies once prosody is enabled.
    expect(report.allTime.cost).toBeCloseTo(1.3, 4);
  });
});

describe("getSpendReport — no rate configured", () => {
  it("reports usage exactly and omits money entirely", async () => {
    // A wrong rate shown as money is worse than no money, because nobody
    // re-checks a number that looks authoritative.
    aggregateResult = facet(
      { calls: 61, audioSeconds: 285.2, billableSeconds: 313, indeterminateCalls: 7, indeterminateSeconds: 32 },
      { calls: 4, audioSeconds: 12, billableSeconds: 14 },
    );
    const getSpendReport = await loadWith({ AZURE_SPEECH_RATE_PER_AUDIO_HOUR: undefined });

    const report = await getSpendReport();

    expect(report.rate.perAudioHour).toBeNull();
    expect(report.allTime.cost).toBeNull();
    expect(report.allTime.indeterminateCost).toBeNull();
    // Usage is still exact — it does not depend on knowing the price.
    expect(report.allTime.calls).toBe(61);
    expect(report.allTime.billableSeconds).toBe(313);
  });

  it("defaults the currency rather than leaving it blank", async () => {
    const getSpendReport = await loadWith({ AZURE_SPEECH_RATE_CURRENCY: undefined });

    expect((await getSpendReport()).rate.currency).toBe("USD");
  });
});

describe("getSpendReport — the daily cap", () => {
  it("measures today against the cap, not all time", async () => {
    // The cap is a daily budget; comparing a lifetime total to it would show a
    // ceiling breached that has not been.
    aggregateResult = facet({ calls: 5000, billableSeconds: 5000 }, { calls: 500, billableSeconds: 500 });
    const getSpendReport = await loadWith({ MAX_DAILY_SCORING_CALLS: "2000" });

    const report = await getSpendReport();

    expect(report.dailyCallCap).toBe(2000);
    expect(report.capUsedFraction).toBeCloseTo(0.25, 4);
  });

  it("clamps at 1 rather than reporting more than a full cap", async () => {
    // The in-process counter resets on restart, so Mongo can legitimately show
    // more calls today than the cap allows — a bar past 100% would look like a
    // bug rather than a restart.
    aggregateResult = facet({ calls: 3000 }, { calls: 3000 });
    const getSpendReport = await loadWith({ MAX_DAILY_SCORING_CALLS: "2000" });

    expect((await getSpendReport()).capUsedFraction).toBe(1);
  });
});

describe("getSpendReport — an empty or partial ledger", () => {
  it("reports zeros rather than throwing when nothing has been scored", async () => {
    // A fresh database returns a facet with empty arrays, not zeroed documents.
    aggregateResult = [{ allTime: [], today: [] }];
    const getSpendReport = await loadWith({ AZURE_SPEECH_RATE_PER_AUDIO_HOUR: "1.00" });

    const report = await getSpendReport();

    expect(report.allTime.calls).toBe(0);
    expect(report.allTime.billableSeconds).toBe(0);
    expect(report.allTime.cost).toBe(0);
    expect(report.capUsedFraction).toBe(0);
  });

  it("survives the aggregation returning nothing at all", async () => {
    aggregateResult = [];
    const getSpendReport = await loadWith({ AZURE_SPEECH_RATE_PER_AUDIO_HOUR: "1.00" });

    await expect(getSpendReport()).resolves.toMatchObject({
      allTime: { calls: 0 },
      today: { calls: 0 },
    });
  });
});
