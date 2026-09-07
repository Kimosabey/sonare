/**
 * What the server has been doing, aggregated.
 *
 * Every number here was already being measured and thrown away. Each attempt
 * records `providerMs` and `totalMs`; each result knows whether it was
 * indeterminate and whether the provider found a miscue. None of it was ever
 * summed, so the only way to notice a provider slowdown or a rising
 * indeterminate rate was a learner complaining — which is a monitoring
 * strategy with a person in the hot path.
 *
 * In-process and cumulative since start, which is the honest scope and worth
 * stating plainly: two instances report two sets of figures, and a restart
 * resets them. That is a real limitation, and unlike the spend ceiling it does
 * not need fixing first — a metric that under-reports after a deploy is a
 * smaller problem than a bill that does, and scraping both instances is the
 * normal way to read this anyway.
 *
 * No dependency. A counter is a number and a percentile is a sort; a metrics
 * library would bring a registry, a text-format serialiser and a scrape
 * endpoint contract to replace forty lines.
 */

/**
 * Latency samples kept per histogram.
 *
 * A bounded reservoir rather than every sample ever: percentiles are only
 * interesting over the recent past, and an unbounded array is a memory leak
 * that grows with traffic. A thousand is enough for a stable p99 and small
 * enough to sort on demand without noticing.
 *
 * The consequence is stated in the output: these percentiles describe the last
 * thousand calls, not all of them.
 */
const RESERVOIR = 1000;

class Histogram {
  private samples: number[] = [];

  private total = 0;

  private seen = 0;

  public observe(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.seen += 1;
    this.total += ms;
    if (this.samples.length < RESERVOIR) {
      this.samples.push(ms);
      return;
    }
    /**
     * Reservoir sampling, so the window stays representative rather than
     * being the most recent thousand.
     *
     * A plain ring buffer would make p99 describe only the last thousand
     * calls, which on a busy minute is the last minute — and a slow tail that
     * happens every few hundred calls would vanish and reappear. Random
     * replacement keeps a uniform sample of everything seen.
     */
    const index = Math.floor(Math.random() * this.seen);
    if (index < RESERVOIR) this.samples[index] = ms;
  }

  /** Nearest-rank percentile. Null when nothing has been observed. */
  public percentile(fraction: number): number | null {
    if (this.samples.length === 0) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
    return sorted[rank] ?? null;
  }

  public get count(): number {
    return this.seen;
  }

  public get mean(): number | null {
    return this.seen === 0 ? null : Number((this.total / this.seen).toFixed(1));
  }

  public reset(): void {
    this.samples = [];
    this.total = 0;
    this.seen = 0;
  }
}

/** Every counter the server keeps. Named so a typo is a type error. */
export type CounterName =
  | "scoring.calls"
  | "scoring.indeterminate"
  | "scoring.miscue"
  | "scoring.errors"
  /** Transient provider failures that were retried. A rise means Azure is flaky. */
  | "scoring.provider.retried"
  | "scoring.refused.cap"
  | "upload.rejected"
  | "sync.push"
  | "sync.push.failed"
  | "sync.pull"
  | "sync.pull.failed"
  | "identity.registered"
  | "identity.rejected"
  | "fallback.written";

const counters = new Map<CounterName, number>();

const histograms = {
  /** Time inside the provider call alone. */
  provider: new Histogram(),
  /** The whole request, so the difference is our own overhead. */
  total: new Histogram(),
};

export function increment(name: CounterName, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function observeScoringLatency(providerMs: number, totalMs: number): void {
  histograms.provider.observe(providerMs);
  histograms.total.observe(totalMs);
}

/** A rate, or null when the denominator is zero. Never a spurious 0%. */
function rate(numerator: CounterName, denominator: CounterName): number | null {
  const bottom = counters.get(denominator) ?? 0;
  if (bottom === 0) return null;
  return Number(((counters.get(numerator) ?? 0) / bottom).toFixed(4));
}

export interface MetricsSnapshot {
  /** Seconds since this process started. Resets on deploy — see the note. */
  uptimeSeconds: number;
  counters: Record<string, number>;
  latency: {
    /**
     * Percentiles over a reservoir sample, not every call. Stated in the
     * payload so a reader is not left assuming otherwise.
     */
    sampleSize: number;
    provider: { count: number; mean: number | null; p50: number | null; p95: number | null; p99: number | null };
    total: { count: number; mean: number | null; p50: number | null; p95: number | null; p99: number | null };
  };
  /**
   * The figures worth alerting on, computed here so an alert rule does not
   * have to know which counters to divide.
   *
   * Null rather than zero where nothing has happened yet: a 0% indeterminate
   * rate on a server that has scored nothing is not good news, and an alert
   * comparing null against a threshold is one that has to be written
   * deliberately.
   */
  rates: {
    indeterminate: number | null;
    miscue: number | null;
    error: number | null;
    syncPushFailure: number | null;
  };
}

function summarise(histogram: Histogram) {
  return {
    count: histogram.count,
    mean: histogram.mean,
    p50: histogram.percentile(0.5),
    p95: histogram.percentile(0.95),
    p99: histogram.percentile(0.99),
  };
}

export function snapshot(): MetricsSnapshot {
  return {
    uptimeSeconds: Math.round(process.uptime()),
    counters: Object.fromEntries(counters),
    latency: {
      sampleSize: RESERVOIR,
      provider: summarise(histograms.provider),
      total: summarise(histograms.total),
    },
    rates: {
      indeterminate: rate("scoring.indeterminate", "scoring.calls"),
      miscue: rate("scoring.miscue", "scoring.calls"),
      error: rate("scoring.errors", "scoring.calls"),
      syncPushFailure: rate("sync.push.failed", "sync.push"),
    },
  };
}

/** For tests. Never called by the server — the figures are cumulative. */
export function resetMetrics(): void {
  counters.clear();
  histograms.provider.reset();
  histograms.total.reset();
}
