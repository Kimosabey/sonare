/**
 * Thresholds over the numbers metrics.ts already collects.
 *
 * The gap this closes: every figure needed to notice a failure was already
 * being measured — latency percentiles over a uniform reservoir, an
 * indeterminate rate that is null rather than falsely zero, a `fallbackPending`
 * gauge read from disk, a daily spend window with a cap beside it — and
 * **nothing watched any of it**. Noticing a failure still required a person to
 * open a page and read a number, which is monitoring with a human in the hot
 * path.
 *
 * Four rules, chosen because they cover the realistic failures rather than
 * because they were easy to compute:
 *
 *   indeterminateRate    a capture or resample regression: audio still
 *                        arrives, the provider still answers, and the answer
 *                        is "no score" more often than it used to be.
 *   providerLatencyP95   the provider slowing down before it starts timing
 *                        out, which is the window in which anything can be
 *                        done about it.
 *   dailySpend           the cost ceiling approaching, while calls still
 *                        succeed. After the cap is hit the failure announces
 *                        itself; before it, nothing does.
 *   fallbackPending      an outage that **already happened**. A non-zero
 *                        value means a Mongo write failed and a learner's
 *                        record went to a local file instead — and because
 *                        that failover is deliberately silent, so that no
 *                        learner's request ever fails over a log write, this
 *                        is the only outward sign it occurred.
 *
 * What this file deliberately is not
 * ----------------------------------
 * There is no notification channel, no webhook and no scheduler here. Email,
 * push and any external alerting provider need an account nobody has set up,
 * and a daemon evaluating on a timer is a second thing to operate. So
 * evaluation is **pull-based**: it happens when an operator surface is read
 * (`GET /metrics`), and the breach state is part of that response.
 *
 * The honest consequence, stated rather than buried: an unscraped server
 * evaluates nothing. This turns "you must read four numbers and judge them"
 * into "you must read one boolean", which is a real reduction in what an
 * operator has to know, and it is not the same as being told. Wiring a scrape
 * to something that can wake somebody up is the remaining half, and it belongs
 * in a commit with an account behind it.
 *
 * Logging is on **state transition only** — firing, and resolved. A line per
 * evaluation would be a line per scrape, which is how a log stops being read.
 */

import { logger } from "../logger.js";
import { numberFromEnv } from "../env.js";
import { getSpendReport } from "../spend.js";
import type { FallbackCollection } from "../fallbackLog.js";
import type { MetricsSnapshot } from "./metrics.js";

/**
 * Indeterminate rate that counts as a regression.
 *
 * The baseline is measured, not guessed: **7.2%** across the 139 real stored
 * attempts. That number is also why the threshold is not the baseline. At
 * n=139 the binomial standard error on 7.2% is about 2.2 points, so a rule set
 * at baseline would fire on sampling noise roughly half the time — and an
 * alert that fires when nothing is wrong is worse than no alert, because it
 * teaches its reader to close it.
 *
 * 15% is a little over double the baseline and about 3.5 standard errors above
 * it. It is the first value worth a look, not the last acceptable one.
 */
const INDETERMINATE_RATE = numberFromEnv("ALERT_INDETERMINATE_RATE", 0.15, { max: 1, integer: false });

/**
 * Provider p95 that counts as a slowdown.
 *
 * Anchored to the numbers either side of it. A single provider attempt is
 * abandoned at 8s (azureSpeech.ts's RECOGNITION_TIMEOUT_MS) and the client
 * gives up on the whole exchange at 25s. A p95 of 4s means one call in twenty
 * has spent half its attempt budget — late enough to be a real change, early
 * enough that calls are still succeeding, which is the only useful place for
 * this line to sit.
 *
 * A literal rather than a value derived from azureSpeech.ts, on purpose:
 * importing that module here would pull the Azure SDK into the health route's
 * import graph, and R12 keeps the vendor inside server/services/.
 */
const PROVIDER_P95_MS = numberFromEnv("ALERT_PROVIDER_P95_MS", 4_000, { integer: true });

/** Fraction of the daily call cap that counts as approaching it. */
const SPEND_CAP_FRACTION = numberFromEnv("ALERT_SPEND_CAP_FRACTION", 0.8, { max: 1, integer: false });

/**
 * Calls a rate or a percentile needs before it means anything.
 *
 * Without this the first scored attempt of a process decides both statistical
 * rules: one indeterminate take out of one call is a 100% indeterminate rate,
 * and a p95 over three samples is just the slowest of three. Both would fire
 * on every restart.
 *
 * Below the floor the state is `unknown` — the same answer the metrics layer
 * gives a rate with no denominator, for the same reason. At fifty calls,
 * firing needs eight indeterminate takes where the 7.2% baseline predicts 3.6:
 * 2.4 standard errors up, unlikely enough to be worth reading and cheap enough
 * to reach within a few minutes of real traffic.
 */
const MIN_SCORING_CALLS = numberFromEnv("ALERT_MIN_SCORING_CALLS", 50, { integer: true });

/**
 * How long a spend read is reused.
 *
 * The spend report is a collection scan over `attempts`, and `/metrics` is
 * something a scraper hits on a timer — so evaluating this rule per scrape
 * would put a full scan on a schedule. A daily cap moves in units of one call;
 * a minute of staleness cannot change the answer to "are we at 80% of it".
 */
const SPEND_CACHE_MS = 60_000;

export type AlertName = "indeterminateRate" | "providerLatencyP95" | "dailySpend" | "fallbackPending";

/**
 * `unknown` is a first-class answer, not a variant of ok.
 *
 * A null rate means "not enough data", and the metrics layer went to some
 * trouble to say null rather than zero — an indeterminate rate of 0% on a
 * server that has scored nothing reads as healthy and is meaningless. Folding
 * that into `ok` here would reintroduce exactly the falsehood that layer was
 * built to avoid; folding it into `firing` would raise an alarm because a
 * process is thirty seconds old.
 */
export type AlertState = "firing" | "ok" | "unknown";

export interface AlertStatus {
  name: AlertName;
  state: AlertState;
  /** The measured figure the state was decided from. Null when nothing was measurable. */
  value: number | null;
  /** What `value` was compared against. Present even when unknown, so the rule stays readable. */
  threshold: number;
  /** One line an operator can act on without reading this file. */
  detail: string;
  /** When the current state began, ISO — not when it was last evaluated. */
  since: string;
}

export interface AlertsReport {
  /** True when at least one rule is firing. `unknown` never counts. */
  firing: boolean;
  alerts: AlertStatus[];
}

/**
 * Everything the four rules read.
 *
 * Passed in rather than fetched inside `evaluateAlerts`, so the arithmetic is
 * testable without a database, a disk or a clock — and so a caller can prove
 * its alerts describe the same snapshot it is about to serve.
 */
export interface AlertInputs {
  /** `rates.indeterminate` — null when nothing has been scored. */
  indeterminateRate: number | null;
  /** The denominator that rate is over. Below MIN_SCORING_CALLS the rule stays unknown. */
  scoringCalls: number;
  providerP95Ms: number | null;
  /** Latency observations behind that percentile. */
  providerSamples: number;
  /** `capUsedFraction` — null when spend is unreadable or no cap is configured. */
  capUsedFraction: number | null;
  /** Unreplayed records on disk, summed. Null when the directory could not be read. */
  fallbackPending: number | null;
}

interface Tracked {
  state: AlertState;
  since: string;
}

/** Last state per rule, so a log line marks a change rather than a scrape. */
const tracked = new Map<AlertName, Tracked>();

let spendCache: { at: number; capUsedFraction: number | null } | null = null;

interface Verdict {
  state: AlertState;
  value: number | null;
  detail: string;
}

/** A fraction as a percentage, for a message a person reads. */
function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function indeterminateRule({ indeterminateRate: rate, scoringCalls }: AlertInputs): Verdict {
  if (rate === null) {
    return { state: "unknown", value: null, detail: "nothing has been scored yet, so there is no rate to judge" };
  }
  if (scoringCalls < MIN_SCORING_CALLS) {
    return {
      state: "unknown",
      value: rate,
      detail: `only ${scoringCalls} of the ${MIN_SCORING_CALLS} calls this rate needs to mean anything`,
    };
  }
  if (rate >= INDETERMINATE_RATE) {
    return {
      state: "firing",
      value: rate,
      detail: `${pct(rate)} of ${scoringCalls} calls returned no score, against a 7.2% baseline — look at capture and resampling`,
    };
  }
  return {
    state: "ok",
    value: rate,
    detail: `${pct(rate)} over ${scoringCalls} calls, within tolerance of the 7.2% baseline`,
  };
}

function latencyRule({ providerP95Ms: p95, providerSamples }: AlertInputs): Verdict {
  if (p95 === null) {
    return { state: "unknown", value: null, detail: "no provider call has been timed yet" };
  }
  if (providerSamples < MIN_SCORING_CALLS) {
    return {
      state: "unknown",
      value: p95,
      detail: `only ${providerSamples} of the ${MIN_SCORING_CALLS} samples a p95 needs — this is the slowest of ${providerSamples}, not a percentile`,
    };
  }
  if (p95 >= PROVIDER_P95_MS) {
    return {
      state: "firing",
      value: p95,
      detail: `provider p95 is ${p95}ms against a ${PROVIDER_P95_MS}ms line, and a single attempt is abandoned at 8000ms`,
    };
  }
  return { state: "ok", value: p95, detail: `provider p95 is ${p95}ms, inside the ${PROVIDER_P95_MS}ms line` };
}

function spendRule({ capUsedFraction: used }: AlertInputs): Verdict {
  if (used === null) {
    return {
      state: "unknown",
      value: null,
      detail: "spend could not be read, or no daily call cap is configured",
    };
  }
  if (used >= SPEND_CAP_FRACTION) {
    return {
      state: "firing",
      value: used,
      detail: `${pct(used)} of today's call cap is spent — calls keep succeeding until the cap, then they stop`,
    };
  }
  return { state: "ok", value: used, detail: `${pct(used)} of today's call cap is spent` };
}

function fallbackRule({ fallbackPending: pending }: AlertInputs): Verdict {
  if (pending === null) {
    return {
      state: "unknown",
      value: null,
      detail: "the fallback directory could not be read, so a backlog cannot be ruled out",
    };
  }
  if (pending > 0) {
    return {
      state: "firing",
      value: pending,
      detail: `${pending} record(s) went to disk because a Mongo write failed — replay with \`npm run replay-fallback\``,
    };
  }
  return { state: "ok", value: 0, detail: "no unreplayed records on disk" };
}

const RULES: ReadonlyArray<{ name: AlertName; threshold: number; run: (inputs: AlertInputs) => Verdict }> = [
  { name: "indeterminateRate", threshold: INDETERMINATE_RATE, run: indeterminateRule },
  { name: "providerLatencyP95", threshold: PROVIDER_P95_MS, run: latencyRule },
  { name: "dailySpend", threshold: SPEND_CAP_FRACTION, run: spendRule },
  // Threshold zero because any backlog at all is the signal: this rule reports
  // an outage that already happened, not a level being approached.
  { name: "fallbackPending", threshold: 0, run: fallbackRule },
];

/**
 * Evaluates the four rules and logs the ones whose state changed.
 *
 * Stateful on purpose. What is kept is the previous verdict per rule, and that
 * is precisely what makes "firing" and "resolved" events rather than a
 * restatement of the current level on every scrape.
 */
export function evaluateAlerts(inputs: AlertInputs, now: Date = new Date()): AlertsReport {
  const at = now.toISOString();

  const alerts = RULES.map(({ name, threshold, run }): AlertStatus => {
    const { state, value, detail } = run(inputs);
    const previous = tracked.get(name);

    /**
     * A first evaluation counts as a transition only when it is firing.
     * Logging every rule's first `ok` would put four lines in the log after
     * every restart, saying that nothing has happened.
     */
    const changed = previous === undefined ? state === "firing" : previous.state !== state;

    if (changed) {
      const from = previous?.state ?? "unstated";
      const line = { alert: name, state, from, value, threshold, detail };
      /**
       * Warn for firing, and warn for a rule that stopped being measurable
       * *while* firing — that is a lost signal rather than a resolution, and
       * calling it resolved would be the more comfortable lie.
       */
      if (state === "firing") logger.warn(line, `[alerts] ${name} is FIRING: ${detail}`);
      else if (from === "firing" && state === "unknown") {
        logger.warn(line, `[alerts] ${name} can no longer be evaluated while it was firing: ${detail}`);
      } else if (from === "firing") logger.info(line, `[alerts] ${name} resolved: ${detail}`);
      else logger.info(line, `[alerts] ${name} is now ${state}: ${detail}`);
    }

    const since = previous === undefined || changed ? at : previous.since;
    tracked.set(name, { state, since });

    return { name, state, value, threshold, detail, since };
  });

  return { firing: alerts.some((alert) => alert.state === "firing"), alerts };
}

/**
 * Today's cap usage, reused for SPEND_CACHE_MS.
 *
 * Never rejects. A spend read that fails is `unknown`: the rule reports that it
 * could not tell, rather than an unhandled rejection taking down the response
 * that was going to say so. The failure is cached like a success, because
 * retrying a collection scan on every scrape during a Mongo outage makes the
 * outage worse.
 */
async function cachedCapUsedFraction(): Promise<number | null> {
  const now = Date.now();
  if (spendCache !== null && now - spendCache.at < SPEND_CACHE_MS) return spendCache.capUsedFraction;

  try {
    const report = await getSpendReport();
    spendCache = { at: now, capUsedFraction: report.capUsedFraction };
  } catch {
    // Deliberately not logged here. The transition into `unknown` is logged by
    // evaluateAlerts, so a per-minute retry cannot fill the log with one line.
    spendCache = { at: now, capUsedFraction: null };
  }

  return spendCache.capUsedFraction;
}

/**
 * Evaluates the rules against a snapshot the caller has already taken.
 *
 * The snapshot is an argument rather than something fetched here so that the
 * breach state served in a response describes the very numbers served beside
 * it. Reading the counters a second time would let the two disagree, and a
 * payload whose alert and whose figure are one scrape apart is one nobody can
 * reason from.
 */
export async function collectAlerts(
  metrics: MetricsSnapshot,
  fallbackPending: Record<FallbackCollection, number> | null,
): Promise<AlertsReport> {
  const { provider } = metrics.latency;

  return evaluateAlerts({
    indeterminateRate: metrics.rates.indeterminate,
    // An absent counter is genuinely zero calls — unlike a rate, where zero
    // and unknown are different claims.
    scoringCalls: metrics.counters["scoring.calls"] ?? 0,
    providerP95Ms: provider.p95,
    providerSamples: provider.count,
    capUsedFraction: await cachedCapUsedFraction(),
    fallbackPending: fallbackPending === null ? null : fallbackPending.attempts + fallbackPending.diagnostics,
  });
}

/** For tests. The transition state is what makes a log line an event. */
export function resetAlerts(): void {
  tracked.clear();
  spendCache = null;
}

/**
 * The thresholds actually in force in *this* module instance.
 *
 * Exported because a test that sets an environment variable and then asserts
 * on behaviour can be reading a different module instance than the one it
 * configured — that has happened in this repository, and four assertions
 * passed for the wrong reason. Every threshold is also on every AlertStatus,
 * so a served response proves which values the running server used.
 */
export const alertThresholds = {
  indeterminateRate: INDETERMINATE_RATE,
  providerLatencyP95Ms: PROVIDER_P95_MS,
  spendCapFraction: SPEND_CAP_FRACTION,
  minScoringCalls: MIN_SCORING_CALLS,
} as const;
