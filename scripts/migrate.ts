/**
 * `npm run migrate` — apply pending migrations. `-- --dry` to preview.
 *
 * A script rather than something the server does at startup. Startup
 * migrations mean a deployment that half-succeeds also half-migrates, and that
 * every instance races the others to do it; more practically, they mean nobody
 * ever sees the plan before it runs. This prints what it will do, and a dry run
 * prints it without doing anything.
 *
 * Exits non-zero on failure so a deployment pipeline stops rather than
 * continuing onto a schema that was not produced.
 */

import { getDb } from "../server/db.js";
import { logger } from "../server/logger.js";
import { pending, run, validate } from "../server/migrations/index.js";
import { MIGRATIONS } from "../server/migrations/list.js";

const dryRun = process.argv.includes("--dry") || process.argv.includes("--dry-run");

async function main(): Promise<void> {
  const problems = validate(MIGRATIONS);
  if (problems.length > 0) {
    for (const problem of problems) logger.error({ problem }, "[migrate] invalid migration list");
    process.exitCode = 1;
    return;
  }

  const db = await getDb();
  const due = await pending(db, MIGRATIONS);

  if (due.length === 0) {
    logger.info({ known: MIGRATIONS.length }, "[migrate] database is up to date");
    return;
  }

  logger.info({ count: due.length, dryRun }, "[migrate] pending migrations");
  for (const migration of due) {
    logger.info({ id: migration.id, description: migration.description }, "[migrate] pending");
  }

  const result = await run(db, MIGRATIONS, { dryRun, by: "npm run migrate" });

  if (result.skippedLocked === true) {
    // Not a failure: another runner is doing the work. Exiting zero lets a
    // rolling deployment proceed rather than failing every instance but one.
    logger.info("[migrate] skipped — another process holds the lock");
    return;
  }

  if (result.failed !== undefined) {
    logger.error(
      { failed: result.failed, applied: result.ids },
      "[migrate] stopped part-way — the migrations listed as applied are done, the rest are not",
    );
    process.exitCode = 1;
    return;
  }

  logger.info({ applied: result.ids, dryRun }, dryRun ? "[migrate] dry run complete" : "[migrate] applied");
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, "[migrate] failed");
    process.exitCode = 1;
  })
  .finally(() => {
    // The driver keeps the event loop alive, and this is a one-shot script.
    process.exit(process.exitCode ?? 0);
  });
