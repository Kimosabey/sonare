/**
 * Last-resort local persistence for attempts/diagnostics when MongoDB itself
 * is unreachable. Per PRD.md §8 the attempt/diagnostic trail *is* the
 * deliverable, not an incidental log — silently dropping a record on a
 * transient Mongo hiccup can invalidate the exact measurement the product
 * exists to make. NDJSON, append-only, so a crash mid-write never corrupts a
 * prior line. Replay with `npm run replay-fallback` once Mongo is back.
 */

import { appendFile, mkdir, readFile, rename } from "node:fs/promises";
import type { Db } from "mongodb";
import { join } from "node:path";
import { logger } from "./logger.js";
import { increment } from "./infra/metrics.js";

const FALLBACK_DIR = process.env.FALLBACK_DIR ?? join(process.cwd(), "data");

export type FallbackCollection = "attempts" | "diagnostics";

export function fallbackPath(collection: FallbackCollection): string {
  return join(FALLBACK_DIR, `${collection}.fallback.ndjson`);
}

export async function appendFallback(collection: FallbackCollection, record: unknown): Promise<void> {
  try {
    await mkdir(FALLBACK_DIR, { recursive: true });
    await appendFile(fallbackPath(collection), `${JSON.stringify(record)}\n`, "utf8");
    /**
     * Counted, because a non-zero value here means a Mongo write already
     * failed — and that failure is deliberately silent everywhere else, so a
     * learner's request never fails over a log write. This counter is the only
     * outward sign that an outage happened at all, which makes it the one
     * worth alerting on rather than the one worth ignoring.
     */
    increment("fallback.written");
  } catch (err) {
    // Nothing left to fall back to. Same non-blocking philosophy as the
    // Mongo write this backs up: log and move on, never throw into a
    // learner's request.
    logger.error({ err, collection }, "[fallback] failed to append record");
  }
}

export const FALLBACK_COLLECTIONS: readonly FallbackCollection[] = ["attempts", "diagnostics"];

/**
 * Records waiting to be replayed, read from disk.
 *
 * The `fallback.written` counter is not enough on its own, and the gap matters:
 * it counts writes *since this process started*, so a restart with a full
 * backlog reads as zero. The one moment somebody most wants to know there is
 * unreplayed learner data is right after the restart that ended the outage.
 *
 * So this is a gauge rather than a counter — it asks the filesystem, and it is
 * therefore true regardless of how many times the process has come and gone.
 */
export async function countPending(): Promise<Record<FallbackCollection, number>> {
  const out = { attempts: 0, diagnostics: 0 };

  for (const collection of FALLBACK_COLLECTIONS) {
    try {
      const text = await readFile(fallbackPath(collection), "utf8");
      out[collection] = text.split("\n").filter((line) => line.trim().length > 0).length;
    } catch {
      // No file is the healthy case, not an error.
    }
  }

  return out;
}

export interface ReplayOutcome {
  collection: FallbackCollection;
  records: number;
  archivedAs: string | null;
  error?: string;
}

/**
 * Replays one collection's backlog into Mongo and archives the file.
 *
 * `ordered: false` so one bad record — a duplicate `_id` from a partial
 * earlier replay — does not block the rest. The file is archived rather than
 * deleted: it holds real learner data, and a rename is reversible where an
 * unlink is not.
 *
 * The file is only archived on a *successful* insert. Renaming first would
 * lose the backlog if the insert then failed, which is the one thing this
 * whole mechanism exists to prevent.
 */
async function replayOne(db: Db, collection: FallbackCollection): Promise<ReplayOutcome> {
  const path = fallbackPath(collection);

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { collection, records: 0, archivedAs: null };
  }

  const records: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      // Only an object can be a document. A bare number or string on its own
      // line is a torn write, not a record.
      if (typeof parsed === "object" && parsed !== null) {
        records.push(parsed as Record<string, unknown>);
      }
    } catch {
      // A line torn by a crash mid-write. Skipped rather than failing the
      // whole replay, which would strand every intact record behind it.
      logger.warn({ collection }, "[fallback] skipping an unparseable line");
    }
  }
  if (records.length === 0) return { collection, records: 0, archivedAs: null };

  try {
    await db.collection(collection).insertMany(records, { ordered: false });
  } catch (err) {
    return {
      collection,
      records: records.length,
      archivedAs: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const archivedAs = `${path}.${Date.now()}.replayed`;
  await rename(path, archivedAs);
  return { collection, records: records.length, archivedAs };
}

/**
 * Drains every backlog. Safe to call any time — an absent or empty file is a
 * no-op rather than an error.
 *
 * Shared by the startup path and `npm run replay-fallback`, so there is one
 * implementation of "how a backlog is drained" rather than two that can
 * disagree about whether the file gets archived.
 */
export async function replayPending(db: Db): Promise<ReplayOutcome[]> {
  const out: ReplayOutcome[] = [];
  for (const collection of FALLBACK_COLLECTIONS) {
    out.push(await replayOne(db, collection));
  }
  return out;
}
