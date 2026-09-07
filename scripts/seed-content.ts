/**
 * `npm run seed-content` — publish the bundled activity sets to the database.
 *
 * The bundle stops being the source of truth and becomes the seed. After this,
 * a phrase can be corrected by publishing a new version rather than shipping a
 * build — and the bundle stays as the offline fallback, which is what keeps
 * the app usable with no network.
 *
 * Idempotent by refusal rather than by overwrite: a language that already has
 * a published version is skipped, because publishing an identical set as
 * version 2 would be noise, and overwriting version 1 would change the words
 * under a learner who is mid-session. `--force` publishes the next version
 * anyway, which is how a corrected bundle gets out.
 *
 *   npm run seed-content              publish anything not yet published
 *   npm run seed-content -- --force   publish the bundle as the next version
 *
 * This is the one script that reads from src/. That is deliberate and narrow:
 * tsconfig.scripts.json already lists src/activities as shared, the content
 * modules are pure data with no DOM in them, and the alternative is
 * maintaining a second copy of every phrase.
 */

import { getDb } from "../server/db.js";
import { logger } from "../server/logger.js";
import { latestVersion, publish } from "../server/store/content.js";
import { LANGUAGES } from "../src/activities/languages/index.js";

const force = process.argv.includes("--force");

async function main(): Promise<void> {
  const db = await getDb();
  let published = 0;
  let skipped = 0;

  for (const set of LANGUAGES) {
    const current = await latestVersion(db, set.slug);

    if (current > 0 && !force) {
      logger.info({ slug: set.slug, version: current }, "[seed-content] already published — skipping");
      skipped += 1;
      continue;
    }

    const next = current + 1;
    const document = await publish(
      db,
      {
        slug: set.slug,
        code: set.code,
        label: set.label,
        activities: set.activities.map((a) => ({
          id: a.id,
          title: a.title,
          kind: a.kind,
          prompt: a.prompt,
          gloss: a.gloss,
          target: a.target,
          focus: a.focus,
        })),
      },
      next,
    );

    logger.info(
      { slug: set.slug, version: document.version, activities: document.activities.length },
      "[seed-content] published",
    );
    published += 1;
  }

  logger.info({ published, skipped, force }, "[seed-content] done");
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, "[seed-content] failed");
    process.exitCode = 1;
  })
  .finally(() => {
    // The driver keeps the event loop alive, and this is a one-shot script.
    process.exit(process.exitCode ?? 0);
  });
