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
 *   npm run seed-content -- --course  publish the course-shaped set instead
 *
 * This is the one script that reads from src/. That is deliberate and narrow:
 * tsconfig.scripts.json already lists src/activities as shared, the content
 * modules are pure data with no DOM in them, and the alternative is
 * maintaining a second copy of every phrase.
 *
 * ## `--course`, and why it is not the default
 *
 * A course-shaped set (src/activities/courses/) carries units, lessons,
 * `soundTargets`, and the `read` and `recall` activities the flat set has
 * none of. Publishing it is how the spine reaches a learner — content is
 * versioned and immutable, so it arrives as the *next version* and every
 * document already published stays exactly as it was.
 *
 * It is opt-in because a published version reaches clients immediately and the
 * screens for two of those kinds are not built yet: `read` rendered by today's
 * session screen would show a Listen button, which is precisely the thing that
 * makes it a `repeat` instead, and `recall` would show the target it exists to
 * hide. So the flag is the gate between "the content is written" and "the
 * content is in front of someone", and it belongs to whoever deploys C6 rather
 * than to whoever wrote the phrases.
 *
 * A language with no course authored publishes its flat set under `--course`
 * too, rather than being skipped: the flag says which shape to prefer, not
 * which languages to touch.
 */

import { getDb } from "../server/db.js";
import { logger } from "../server/logger.js";
import { latestVersion, publish } from "../server/store/content.js";
import { LANGUAGES } from "../src/activities/languages/index.js";
import { getCourse } from "../src/activities/courses/index.js";

const force = process.argv.includes("--force");
const course = process.argv.includes("--course");

async function main(): Promise<void> {
  const db = await getDb();
  let published = 0;
  let skipped = 0;

  for (const bundled of LANGUAGES) {
    // The course set where one is authored, the flat set everywhere else.
    // `LANGUAGES` stays the list of what exists, so `--course` cannot quietly
    // publish a different set of languages from a plain run.
    const set = (course ? getCourse(bundled.slug) : undefined) ?? bundled;
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
          // Copied field by field like everything else here, so a field added
          // to the model is a compile error in this file rather than a field
          // that silently stops being published.
          ...(a.soundTargets === undefined ? {} : { soundTargets: [...a.soundTargets] }),
        })),
        ...(set.units === undefined
          ? {}
          : {
              units: set.units.map((u) => ({
                id: u.id,
                title: u.title,
                outcome: u.outcome,
                lessons: u.lessons.map((l) => ({
                  id: l.id,
                  title: l.title,
                  outcome: l.outcome,
                  activityIds: [...l.activityIds],
                })),
              })),
            }),
      },
      next,
    );

    logger.info(
      {
        slug: set.slug,
        version: document.version,
        activities: document.activities.length,
        units: document.units?.length ?? 0,
      },
      "[seed-content] published",
    );
    published += 1;
  }

  logger.info({ published, skipped, force, course }, "[seed-content] done");
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
