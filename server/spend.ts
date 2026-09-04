/**
 * What the scoring has actually cost.
 *
 * Deliberately a server-side aggregation rather than a client-side sum over
 * the loaded snapshot. Diagnostics.tsx's other figures are explicitly "the
 * most recent N records — a snapshot, not a full-history query", which is
 * right for spotting a trend and wrong for money: a spend number that only
 * covers the last 50 attempts is worse than none, because it reads as a total.
 *
 * Every scored attempt is one billed provider call, so `attempts` is the
 * billing ledger whether or not it was written for that purpose. It also
 * survives restarts, which the in-process daily counter in services/index.ts
 * does not — so "calls today" here is the trustworthy figure and that counter
 * is only a within-process guard.
 */

import { getDb } from "./db.js";
import { numberFromEnv, optionalNumberFromEnv } from "./env.js";

/**
 * Price per audio-hour for the active region and tier.
 *
 * Left unset by default on purpose: there is no safe default across regions,
 * and a wrong rate shown as money is worse than no money at all, because
 * nobody re-checks a number that looks authoritative. With this unset the
 * endpoint reports exact usage and omits cost entirely.
 *
 * For reference, verified against Azure's pricing page and the Retail Prices
 * API on 2 Sep 2026: speech-to-text Standard in `southeastasia` is
 * **$1.00 per audio hour**, and pronunciation assessment is not a separate
 * meter — it bills as baseline speech-to-text. 33 of 36 regions share that
 * rate; only the US Government regions differ ($1.25).
 *
 * Two things would change it. Prosody is an add-on billed under a separate
 * "Enhanced Feature Audio" meter at $0.30/hr — azureSpeech.ts never sets
 * `enableProsodyAssessment`, so it does not apply today, but enabling it means
 * raising this to 1.30. And a commitment tier replaces per-hour pricing
 * entirely.
 */
// Unusable reads as unset, deliberately: this file's own principle is that a
// wrong rate shown as money is worse than no money, because nobody re-checks
// a number that looks authoritative.
const RATE_PER_AUDIO_HOUR = optionalNumberFromEnv("AZURE_SPEECH_RATE_PER_AUDIO_HOUR");

const RATE_CURRENCY = process.env.AZURE_SPEECH_RATE_CURRENCY ?? "USD";

const DAILY_CALL_CAP = numberFromEnv("MAX_DAILY_SCORING_CALLS", 2000, { integer: true });

export interface SpendWindow {
  calls: number;
  audioSeconds: number;
  /**
   * What Azure actually charges for, which is not the same as `audioSeconds`.
   * Billing is per second **rounded up to the whole second** per request, so a
   * 0.4s clip bills a full second. Summing raw durations understates the bill,
   * and understates it worst exactly where it matters to the fixture decision:
   * a run of 80 sub-second words sends ~44s of audio and is billed 80s.
   */
  billableSeconds: number;
  /** Calls that returned no score. Billed all the same — see the note below. */
  indeterminateCalls: number;
  indeterminateSeconds: number;
  /** Null whenever no rate is configured. */
  cost: number | null;
  /**
   * Cost of the calls that produced no usable score. Not waste in the sense of
   * a bug — an indeterminate result is the honest answer and R8 requires it —
   * but it is spend that bought no learner feedback, which is the number worth
   * watching when a fixture run starts costing more than expected.
   */
  indeterminateCost: number | null;
}

export interface SpendReport {
  allTime: SpendWindow;
  today: SpendWindow;
  rate: { perAudioHour: number | null; currency: string };
  dailyCallCap: number;
  /** Ticks up as `today.calls` approaches the cap. 0–1, or null with no cap. */
  capUsedFraction: number | null;
}

interface RawWindow {
  calls?: number;
  audioSeconds?: number;
  billableSeconds?: number;
  indeterminateCalls?: number;
  indeterminateSeconds?: number;
}

function toWindow(raw: RawWindow | undefined): SpendWindow {
  const audioSeconds = raw?.audioSeconds ?? 0;
  const billableSeconds = raw?.billableSeconds ?? 0;
  const indeterminateSeconds = raw?.indeterminateSeconds ?? 0;
  const perSecond = RATE_PER_AUDIO_HOUR === null ? null : RATE_PER_AUDIO_HOUR / 3600;

  // Cost comes off billable seconds, never raw duration — see billableSeconds.
  return {
    calls: raw?.calls ?? 0,
    audioSeconds: Number(audioSeconds.toFixed(2)),
    billableSeconds,
    indeterminateCalls: raw?.indeterminateCalls ?? 0,
    indeterminateSeconds: Number(indeterminateSeconds.toFixed(2)),
    cost: perSecond === null ? null : Number((billableSeconds * perSecond).toFixed(4)),
    indeterminateCost: perSecond === null ? null : Number((indeterminateSeconds * perSecond).toFixed(4)),
  };
}

function startOfUtcDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function getSpendReport(): Promise<SpendReport> {
  const db = await getDb();

  /**
   * One pass, two windows, via $facet — rather than two round trips that could
   * straddle midnight and disagree with each other.
   *
   * `createdAt` is the BSON Date attempts.ts adds for the TTL index; `at` is a
   * display string and cannot be range-matched. Note the consequence: records
   * older than RETENTION_DAYS have been expired by that index, so "all time"
   * honestly means "within the retention window".
   */
  const [facet] = await db
    .collection("attempts")
    .aggregate<{ allTime: RawWindow[]; today: RawWindow[] }>([
      {
        $facet: {
          allTime: [{ $group: groupSpec() }],
          today: [{ $match: { createdAt: { $gte: startOfUtcDay() } } }, { $group: groupSpec() }],
        },
      },
    ])
    .toArray();

  const today = toWindow(facet?.today?.[0]);

  return {
    allTime: toWindow(facet?.allTime?.[0]),
    today,
    rate: { perAudioHour: RATE_PER_AUDIO_HOUR, currency: RATE_CURRENCY },
    dailyCallCap: DAILY_CALL_CAP,
    capUsedFraction:
      DAILY_CALL_CAP > 0 ? Number(Math.min(1, today.calls / DAILY_CALL_CAP).toFixed(4)) : null,
  };
}

/**
 * Shared so both windows are computed identically — the whole point of showing
 * today beside all-time is that the two are comparable.
 *
 * `$ifNull` on the duration because early records predate the current audio
 * shape, and a missing field would poison the whole sum with null rather than
 * contributing nothing.
 */
function groupSpec() {
  return {
    _id: null,
    calls: { $sum: 1 },
    audioSeconds: { $sum: { $ifNull: ["$audio.seconds", 0] } },
    // $ceil per document, not on the total: the round-up is per request.
    billableSeconds: { $sum: { $ceil: { $ifNull: ["$audio.seconds", 0] } } },
    indeterminateCalls: { $sum: { $cond: [{ $eq: ["$result.indeterminate", true] }, 1, 0] } },
    indeterminateSeconds: {
      $sum: {
        $cond: [
          { $eq: ["$result.indeterminate", true] },
          { $ceil: { $ifNull: ["$audio.seconds", 0] } },
          0,
        ],
      },
    },
  };
}
