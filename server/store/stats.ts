/**
 * One document per day, so a trend outlives the takes it came from.
 *
 * `attempts` expires after ninety days because it holds spoken phrases,
 * device context and session ids. That is right for the raw records and wrong
 * for the shape of the thing: "was the indeterminate rate always this high"
 * is a question about last spring, and there is no answer to it once the
 * evidence has been swept.
 *
 * So each day is aggregated into a small document with **no learner content in
 * it at all** — counts, seconds, means — and that document has no TTL. It is
 * not a copy of the attempts kept longer; it is a different kind of data that
 * happens to be derived from them, which is what makes keeping it indefinitely
 * a different decision from keeping them.
 *
 * Deliberately not the in-process metrics (infra/metrics.ts). Those reset on
 * deploy and describe one instance; this is computed from the durable record,
 * so it is the same number whoever asks and whenever.
 */

import type { Db } from "mongodb";
import { getDb } from "../db.js";
import { logger } from "../logger.js";

export interface StatsDocument {
  /** `YYYY-MM-DD`, UTC — matching how the provider bills and how attempts expire. */
  _id: string;
  calls: number;
  indeterminate: number;
  miscue: number;
  audioSeconds: number;
  /** Rounded up per call, as the provider charges. */
  billableSeconds: number;
  meanProviderMs: number | null;
  meanTotalMs: number | null;
  /**
   * Distinct learners seen that day.
   *
   * A count, never the ids. The point of this collection is that it can be
   * kept forever, and a list of who practised on a given day is exactly the
   * kind of thing that would make that a privacy decision rather than an
   * operational one.
   */
  learners: number;
  /** When the rollup ran, so a stale or re-run day is recognisable. */
  computedAt: Date;
}

function dayBounds(day: string): { start: Date; end: Date } {
  const start = new Date(`${day}T00:00:00.000Z`);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

/** `YYYY-MM-DD` and a real date — 2026-02-30 parses happily to 2 March. */
export function isDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Yesterday, UTC — the last day that is definitely complete. */
export function previousDay(now: Date = new Date()): string {
  return new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
}

/**
 * Aggregates one day and stores it.
 *
 * Idempotent by construction: the day is the `_id` and the write is a replace,
 * so re-running is how a day gets corrected rather than doubled. That matters
 * because the obvious failure here is a cron that fires twice.
 *
 * `$ifNull` on every summed field because early records predate the current
 * shape, and one missing field would otherwise make the whole sum null —
 * turning a real day into a blank one with no error anywhere.
 */
export async function rollupDay(db: Db, day: string): Promise<StatsDocument> {
  if (!isDay(day)) throw new Error(`not a day: ${day}`);
  const { start, end } = dayBounds(day);

  const [row] = await db
    .collection("attempts")
    .aggregate<{
      calls?: number;
      indeterminate?: number;
      miscue?: number;
      audioSeconds?: number;
      billableSeconds?: number;
      providerMs?: number | null;
      totalMs?: number | null;
      learners?: string[];
    }>([
      { $match: { createdAt: { $gte: start, $lt: end } } },
      {
        $group: {
          _id: null,
          calls: { $sum: 1 },
          indeterminate: { $sum: { $cond: [{ $eq: ["$result.indeterminate", true] }, 1, 0] } },
          /**
           * A miscue is any word the provider did not mark "None". Counted
           * only on scored takes: an indeterminate result has no words, so
           * including them would depress the rate by exactly the
           * indeterminate rate and make both figures harder to read.
           */
          miscue: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $ne: ["$result.indeterminate", true] },
                    { $gt: [{ $size: { $ifNull: ["$result.words", []] } }, 0] },
                    {
                      $gt: [
                        {
                          $size: {
                            $filter: {
                              input: { $ifNull: ["$result.words", []] },
                              as: "word",
                              cond: { $ne: ["$$word.errorType", "None"] },
                            },
                          },
                        },
                        0,
                      ],
                    },
                  ],
                },
                1,
                0,
              ],
            },
          },
          audioSeconds: { $sum: { $ifNull: ["$audio.seconds", 0] } },
          billableSeconds: { $sum: { $ceil: { $ifNull: ["$audio.seconds", 0] } } },
          providerMs: { $avg: "$timings.providerMs" },
          totalMs: { $avg: "$timings.totalMs" },
          // Collected to be counted, then discarded — see the field comment.
          learners: { $addToSet: "$learnerId" },
        },
      },
    ])
    .toArray();

  const document: StatsDocument = {
    _id: day,
    calls: row?.calls ?? 0,
    indeterminate: row?.indeterminate ?? 0,
    miscue: row?.miscue ?? 0,
    audioSeconds: Number((row?.audioSeconds ?? 0).toFixed(2)),
    billableSeconds: row?.billableSeconds ?? 0,
    meanProviderMs: row?.providerMs == null ? null : Number(row.providerMs.toFixed(1)),
    meanTotalMs: row?.totalMs == null ? null : Number(row.totalMs.toFixed(1)),
    // `$addToSet` skips missing fields, so anonymous attempts do not become a
    // phantom learner — they simply are not counted, which is honest.
    learners: (row?.learners ?? []).length,
    computedAt: new Date(),
  };

  await db.collection<StatsDocument>("stats").replaceOne({ _id: day }, document, { upsert: true });
  return document;
}

/**
 * Rolls up every day from `from` to `to` inclusive.
 *
 * For backfilling after this shipped, and for catching up after a cron that
 * did not run. Sequential rather than parallel: a backfill of a year is 365
 * collection scans, and firing them at once is a self-inflicted outage on the
 * database everything else depends on.
 */
export async function rollupRange(db: Db, from: string, to: string): Promise<StatsDocument[]> {
  if (!isDay(from) || !isDay(to)) throw new Error(`not a day range: ${from}..${to}`);
  const out: StatsDocument[] = [];

  for (let cursor = from; cursor <= to; ) {
    out.push(await rollupDay(db, cursor));
    cursor = new Date(new Date(`${cursor}T00:00:00.000Z`).getTime() + 86_400_000)
      .toISOString()
      .slice(0, 10);
  }

  return out;
}

/** Days already rolled up, most recent first, for a trend view. */
export async function readStats(limit = 90): Promise<StatsDocument[]> {
  try {
    const db = await getDb();
    return await db
      .collection<StatsDocument>("stats")
      .find({})
      .sort({ _id: -1 })
      .limit(Math.min(400, Math.max(1, limit)))
      .toArray();
  } catch (err) {
    logger.error({ err }, "[stats] failed to read");
    return [];
  }
}
