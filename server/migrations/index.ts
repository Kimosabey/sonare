/**
 * Forward-only, recorded, locked migrations.
 *
 * Required rather than optional now that learner records live server-side.
 * On the client, a schema change is handled by bumping a version inside the
 * storage key, which orphans the old entry — acceptable there, because the
 * cost is one language starting fresh. Server-side that same trick is data
 * loss: the record is the learner's history and there is no second copy to
 * fall back on.
 *
 * **Forward-only, with no `down`.** A rollback that has never been executed is
 * a guess dressed as a plan, and the one time it is needed is the one time
 * nobody wants to discover it was wrong. For data, the real rollback is a
 * restore from a backup that has actually been rehearsed; for code, it is
 * deploying the previous build. A migration is therefore written to be
 * compatible with the build before it wherever it can be.
 *
 * Everything here takes an explicit `Db` rather than calling getDb(), so the
 * runner is testable and so a migration can never quietly run against
 * whichever database happened to be configured.
 */

import type { Db } from "mongodb";
import { logger } from "../logger.js";

export interface Migration {
  /**
   * Sortable and unique, e.g. "0001-attribute-diagnostics".
   *
   * The number decides order and the words say what it does, so a log line or
   * a stuck deployment names the change rather than a hash.
   */
  id: string;
  description: string;
  /** Must be safe to run against a database where it has already run. */
  up: (db: Db) => Promise<void>;
}

interface AppliedDocument {
  _id: string;
  description: string;
  appliedAt: Date;
  ms: number;
}

interface LockDocument {
  _id: string;
  heldSince: Date;
  by: string;
}

const APPLIED = "migrations";
const LOCK_ID = "migrations:lock";

/**
 * How long a lock is honoured before it is treated as abandoned.
 *
 * A process killed mid-migration leaves the lock behind, and without a
 * timeout the next deployment would hang forever on a lock nobody holds.
 * Generous, because the failure mode of expiring too early is two runners at
 * once — which is the thing the lock exists to prevent.
 */
const LOCK_TIMEOUT_MS = 15 * 60 * 1000;

/** Mongo's duplicate-key error — how the lock is won or lost. */
const DUPLICATE_KEY = 11000;

function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === DUPLICATE_KEY;
}

/**
 * Rejects a list that cannot be reasoned about, before anything runs.
 *
 * Duplicate ids would make "has this run" ambiguous. An unsorted list would
 * run in a different order than it reads, which is the kind of thing that is
 * obvious in hindsight and invisible in review.
 */
export function validate(migrations: Migration[]): string[] {
  const problems: string[] = [];
  const ids = migrations.map((m) => m.id);

  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (duplicates.length > 0) problems.push(`duplicate ids: ${[...new Set(duplicates)].join(", ")}`);

  const sorted = [...ids].sort();
  if (ids.join(" ") !== sorted.join(" ")) {
    problems.push("ids are not in sorted order — the list must read in the order it runs");
  }

  for (const migration of migrations) {
    if (!/^[0-9]{4}-[a-z0-9-]+$/.test(migration.id)) {
      problems.push(`id is not NNNN-kebab-case: ${migration.id}`);
    }
    if (migration.description.trim().length < 10) {
      problems.push(`${migration.id} needs a description saying what it does`);
    }
  }

  return problems;
}

/** Ids already recorded as applied. */
export async function appliedIds(db: Db): Promise<Set<string>> {
  const docs = await db.collection<AppliedDocument>(APPLIED).find({}).toArray();
  return new Set(docs.map((d) => d._id).filter((id) => id !== LOCK_ID));
}

export async function pending(db: Db, migrations: Migration[]): Promise<Migration[]> {
  const applied = await appliedIds(db);
  return migrations.filter((m) => !applied.has(m.id));
}

/**
 * Takes the lock, so two instances starting together cannot both migrate.
 *
 * A conditional insert: whoever inserts the document first wins, everyone else
 * collides on the `_id` and backs off. An expired lock is reclaimed, because
 * otherwise a process killed mid-run would block every future deployment.
 */
async function acquireLock(db: Db, by: string): Promise<boolean> {
  const collection = db.collection<LockDocument>(APPLIED);
  const now = new Date();

  try {
    await collection.insertOne({ _id: LOCK_ID, heldSince: now, by });
    return true;
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
  }

  const stale = new Date(now.getTime() - LOCK_TIMEOUT_MS);
  const taken = await collection.updateOne(
    // Conditional on the lock still being old, so two processes racing to
    // reclaim it cannot both succeed.
    { _id: LOCK_ID, heldSince: { $lt: stale } },
    { $set: { heldSince: now, by } },
  );

  if (taken.matchedCount === 1) {
    logger.warn({ by }, "[migrate] reclaimed an abandoned migration lock");
    return true;
  }
  return false;
}

async function releaseLock(db: Db): Promise<void> {
  await db.collection<LockDocument>(APPLIED).deleteOne({ _id: LOCK_ID });
}

export interface RunResult {
  /** What ran, or would have run under dryRun. */
  ids: string[];
  dryRun: boolean;
  /** Set when the run stopped early. Everything before it is applied. */
  failed?: { id: string; message: string };
  /** True when another process held the lock. Not an error. */
  skippedLocked?: boolean;
}

export interface RunOptions {
  /** Report what would run and change nothing. */
  dryRun?: boolean;
  /** Identifies the holder in the lock document. */
  by?: string;
}

/**
 * Applies every pending migration, in order, one at a time.
 *
 * Each is recorded the moment it succeeds rather than at the end of the run,
 * so a crash part-way leaves the completed ones marked and the next attempt
 * resumes instead of re-running them. Sequential for the same reason a
 * deletion is: with a parallel run, a failure leaves an arbitrary subset
 * applied and nothing says which.
 *
 * Stops at the first failure. Continuing past one would apply a later
 * migration on top of a schema the earlier one was supposed to produce, which
 * turns a clear failure into a corrupt state.
 */
export async function run(
  db: Db,
  migrations: Migration[],
  options: RunOptions = {},
): Promise<RunResult> {
  const dryRun = options.dryRun === true;

  const problems = validate(migrations);
  if (problems.length > 0) {
    // Refused before the lock is taken, so a bad list cannot block a
    // deployment while it is being fixed.
    throw new Error(`migration list is invalid: ${problems.join("; ")}`);
  }

  const due = await pending(db, migrations);
  if (due.length === 0) {
    logger.info("[migrate] nothing to do");
    return { ids: [], dryRun };
  }

  if (dryRun) {
    for (const migration of due) {
      logger.info({ id: migration.id, description: migration.description }, "[migrate] would apply");
    }
    return { ids: due.map((m) => m.id), dryRun: true };
  }

  const by = options.by ?? `pid:${process.pid}`;
  if (!(await acquireLock(db, by))) {
    logger.info("[migrate] another process holds the lock — skipping");
    return { ids: [], dryRun: false, skippedLocked: true };
  }

  const ran: string[] = [];
  try {
    for (const migration of due) {
      const started = Date.now();
      logger.info({ id: migration.id, description: migration.description }, "[migrate] applying");

      try {
        await migration.up(db);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ id: migration.id, err }, "[migrate] failed — stopping here");
        return { ids: ran, dryRun: false, failed: { id: migration.id, message } };
      }

      await db.collection<AppliedDocument>(APPLIED).insertOne({
        _id: migration.id,
        description: migration.description,
        appliedAt: new Date(),
        ms: Date.now() - started,
      });
      ran.push(migration.id);
    }
  } finally {
    // Released even on failure: the lock exists to serialise runners, not to
    // record that something went wrong. Leaving it held would block every
    // later deployment on a problem that has already been logged.
    await releaseLock(db);
  }

  logger.info({ ids: ran }, "[migrate] done");
  return { ids: ran, dryRun: false };
}
