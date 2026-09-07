/**
 * The aggregation that turns measurements already being taken into something
 * anyone can read.
 *
 * Two things here are easy to get subtly wrong and would make the numbers
 * worse than none. A percentile over "the last N calls" hides a slow tail that
 * happens every few hundred requests — it appears and disappears with traffic.
 * And a rate that reports 0% when nothing has happened yet is not good news:
 * an indeterminate rate of zero on a server that has scored nothing reads as
 * healthy and is meaningless.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { increment, observeScoringLatency, resetMetrics, snapshot } from "./metrics.js";

beforeEach(() => {
  resetMetrics();
  vi.restoreAllMocks();
});

describe("counters", () => {
  it("starts with none rather than a row of zeroes", () => {
    // An absent counter says "this has never happened"; a zero says "this has
    // happened zero times so far", and only one of those is knowable at boot.
    expect(snapshot().counters).toEqual({});
  });

  it("counts up", () => {
    increment("scoring.calls");
    increment("scoring.calls");
    increment("scoring.indeterminate");

    expect(snapshot().counters).toEqual({ "scoring.calls": 2, "scoring.indeterminate": 1 });
  });

  it("adds a batch", () => {
    increment("scoring.calls", 5);

    expect(snapshot().counters["scoring.calls"]).toBe(5);
  });

  it("reports uptime, so a reset figure is recognisable as one", () => {
    /**
     * These are cumulative since process start, so a deploy zeroes them.
     * Uptime is what lets a reader tell "nothing is happening" from "this
     * process is thirty seconds old".
     */
    vi.spyOn(process, "uptime").mockReturnValue(3600.4);

    expect(snapshot().uptimeSeconds).toBe(3600);
  });
});

describe("rates", () => {
  it("is null before anything has happened", () => {
    /**
     * The case that matters. A zero here reads as a healthy indeterminate
     * rate on a server that has scored nothing, and an alert comparing zero
     * against a threshold would sit quietly green through a total outage.
     */
    expect(snapshot().rates).toEqual({
      indeterminate: null,
      miscue: null,
      error: null,
      syncPushFailure: null,
    });
  });

  it("divides by the right denominator", () => {
    increment("scoring.calls", 10);
    increment("scoring.indeterminate", 1);
    increment("scoring.miscue", 3);

    expect(snapshot().rates.indeterminate).toBe(0.1);
    expect(snapshot().rates.miscue).toBe(0.3);
  });

  it("reports a genuine zero once there is a denominator", () => {
    // Different from null: this server has scored calls and none of them were
    // indeterminate, which is real information.
    increment("scoring.calls", 10);

    expect(snapshot().rates.indeterminate).toBe(0);
  });

  it("keeps sync failure separate from scoring", () => {
    increment("sync.push", 4);
    increment("sync.push.failed", 1);

    expect(snapshot().rates.syncPushFailure).toBe(0.25);
    expect(snapshot().rates.error).toBeNull();
  });
});

describe("latency", () => {
  it("is null until something is observed", () => {
    const { provider, total } = snapshot().latency;

    expect(provider).toEqual({ count: 0, mean: null, p50: null, p95: null, p99: null });
    expect(total.p99).toBeNull();
  });

  it("reports provider and total separately, so the overhead is readable", () => {
    /**
     * The difference between them is our own time. Reporting only one figure
     * makes a slow provider and a slow server indistinguishable, which are
     * two entirely different things to fix.
     */
    observeScoringLatency(900, 1000);
    observeScoringLatency(1100, 1200);

    const { provider, total } = snapshot().latency;
    expect(provider.mean).toBe(1000);
    expect(total.mean).toBe(1100);
  });

  it("computes percentiles by nearest rank", () => {
    for (let ms = 1; ms <= 100; ms += 1) observeScoringLatency(ms, ms);

    const { provider } = snapshot().latency;
    expect(provider.p50).toBe(50);
    expect(provider.p95).toBe(95);
    expect(provider.p99).toBe(99);
  });

  it("handles a single sample without dividing by zero", () => {
    observeScoringLatency(42, 50);

    const { provider } = snapshot().latency;
    expect(provider.p50).toBe(42);
    expect(provider.p99).toBe(42);
  });

  it("ignores a nonsensical duration rather than poisoning the mean", () => {
    // A negative or NaN elapsed time is a clock or a bug, and one of either
    // would make every percentile meaningless from then on.
    observeScoringLatency(100, 100);
    observeScoringLatency(Number.NaN, -5);
    observeScoringLatency(Number.POSITIVE_INFINITY, 100);

    expect(snapshot().latency.provider.count).toBe(1);
    expect(snapshot().latency.provider.mean).toBe(100);
  });

  it("counts every observation even though it samples", () => {
    // The count is the truth; the reservoir is only how percentiles are
    // estimated. Reporting the sample size as the count would understate
    // traffic by orders of magnitude on a busy server.
    for (let i = 0; i < 5000; i += 1) observeScoringLatency(10, 20);

    expect(snapshot().latency.provider.count).toBe(5000);
  });

  it("keeps a uniform sample rather than the most recent calls", () => {
    /**
     * The subtle one. A ring buffer makes p99 describe only the last thousand
     * requests, so a slow tail occurring every few hundred calls vanishes and
     * reappears with traffic — the metric would be least trustworthy exactly
     * when it is busiest.
     *
     * Here: a thousand slow calls followed by nine thousand fast ones. Under a
     * ring buffer the slow ones would be entirely evicted and p99 would read
     * fast. Under reservoir sampling roughly a tenth of the sample stays slow,
     * so the tail survives.
     */
    for (let i = 0; i < 1000; i += 1) observeScoringLatency(5000, 5000);
    for (let i = 0; i < 9000; i += 1) observeScoringLatency(10, 10);

    const p99 = snapshot().latency.provider.p99;
    expect(p99).not.toBeNull();
    expect(p99).toBeGreaterThan(1000);
  });

  it("states the sample size, so nobody assumes it is every call", () => {
    expect(snapshot().latency.sampleSize).toBe(1000);
  });
});
