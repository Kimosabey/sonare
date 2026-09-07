/**
 * `npm run replay-fallback` — drain the fallback backlog into MongoDB.
 *
 * Safe to run any time: an absent or empty file is a no-op, not an error.
 *
 * The draining itself lives in server/fallbackLog.ts and is shared with the
 * startup path, so there is one implementation of "how a backlog is drained"
 * rather than two that can disagree about whether the file gets archived. This
 * used to be a standalone .mjs with its own copy of that logic.
 *
 * Still worth keeping as a command even though startup replays automatically:
 * a long outage with no restart accumulates records, and this drains them
 * without one.
 */

import { getDb } from "../server/db.js";
import { logger } from "../server/logger.js";
import { countPending, replayPending } from "../server/fallbackLog.js";

async function main(): Promise<void> {
  const pending = await countPending();
  const total = pending.attempts + pending.diagnostics;

  if (total === 0) {
    logger.info("[replay-fallback] nothing pending");
    return;
  }

  logger.info({ pending }, "[replay-fallback] draining");
  const db = await getDb();
  const outcomes = await replayPending(db);

  let failed = false;
  for (const outcome of outcomes) {
    if (outcome.error !== undefined) {
      failed = true;
      logger.error(outcome, "[replay-fallback] could not replay — the file is left in place");
      continue;
    }
    if (outcome.records > 0) logger.info(outcome, "[replay-fallback] replayed");
  }

  // Non-zero so a pipeline or an operator notices the backlog is still there.
  if (failed) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, "[replay-fallback] failed");
    process.exitCode = 1;
  })
  .finally(() => {
    // The driver keeps the event loop alive, and this is a one-shot script.
    process.exit(process.exitCode ?? 0);
  });
