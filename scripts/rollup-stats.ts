/**
 * `npm run rollup-stats` — aggregate a day into the `stats` collection.
 *
 * Defaults to yesterday, which is the last day that is definitely complete.
 * Rolling up today would store a partial figure under a final-looking id, and
 * the re-run that fixed it would be indistinguishable from a correction.
 *
 * A script rather than something the server does on a timer. One process per
 * instance running its own daily job means N writes racing for the same
 * document, and nothing about this needs to be in the request path. Where it
 * runs from — a cron, a scheduled container, a human — is deployment's
 * business, and the write is idempotent so a double fire costs nothing.
 *
 *   npm run rollup-stats                     yesterday
 *   npm run rollup-stats -- 2026-09-01       one day
 *   npm run rollup-stats -- 2026-08-01 2026-08-31   a range, for backfill
 */

import { getDb } from "../server/db.js";
import { logger } from "../server/logger.js";
import { isDay, previousDay, rollupDay, rollupRange } from "../server/store/stats.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const from = args[0] ?? previousDay();
  const to = args[1];

  if (!isDay(from) || (to !== undefined && !isDay(to))) {
    logger.error({ from, to }, "[rollup] expected YYYY-MM-DD dates");
    process.exitCode = 1;
    return;
  }

  const db = await getDb();

  if (to === undefined) {
    const day = await rollupDay(db, from);
    logger.info({ day }, "[rollup] done");
    return;
  }

  const days = await rollupRange(db, from, to);
  logger.info(
    {
      days: days.length,
      calls: days.reduce((sum, d) => sum + d.calls, 0),
      from,
      to,
    },
    "[rollup] done",
  );
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, "[rollup] failed");
    process.exitCode = 1;
  })
  .finally(() => {
    // The driver keeps the event loop alive, and this is a one-shot script.
    process.exit(process.exitCode ?? 0);
  });
