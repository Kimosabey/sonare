/**
 * Serving activity content, so a phrase can be corrected without a deploy.
 *
 * Deliberately readable without a learner token. Content is not personal, the
 * client needs it before a learner has registered, and requiring identity to
 * fetch the words would make the offline-first story worse for no gain.
 *
 * A 404 is the normal answer for a language nobody has published, not an
 * error: the client falls back to the set it shipped with, which is the
 * mechanism that keeps the app working with no network at all.
 *
 * ── the authoring half ──────────────────────────────────────────────────────
 *
 * Everything below the learner's read is the other end of the same mechanism.
 * Content has been servable from the database for a while, but the only way to
 * publish was `npm run seed-content` from a checkout and the only way to
 * correct one phrase was a Mongo client — so the person whose job content is
 * could not do it without an engineer.
 *
 * Three properties the existing design has, which these routes keep rather
 * than reinvent:
 *
 *  - **Versioned and immutable.** `POST` publishes the *next* version and
 *    there is deliberately no route that edits a published one. Rolling back
 *    is publishing an older set forward, which is why loading any version is a
 *    read rather than a restore.
 *  - **It refuses what it cannot serve.** The publish path runs the same
 *    `readDraft`/`publish` gate `seed-content` does, in the store, so an
 *    authoring UI cannot be the lenient way in.
 *  - **A learner offline is unaffected.** Publishing writes a new document and
 *    touches nothing a client already holds; the worst a bad publish can do is
 *    be refused.
 *
 * Token-gated with `requireDiagnosticsToken` — the product's one existing
 * gate, fail-closed when the secret is unset, imported rather than copied
 * (a second implementation is a second place for the "unset means open"
 * mistake). Note it is the *diagnostics* secret: see the report accompanying
 * this change for why authoring arguably wants its own.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { diagnosticsLimiter } from "../rateLimit.js";
import { isSlug } from "../domain/merge.js";
import { getDb } from "../db.js";
import { listVersions, publish, latestVersion, readDraft, readLatest, readVersion } from "../store/content.js";
import { requireDiagnosticsToken } from "./diagnostics.js";
import { logger } from "../logger.js";

export const contentRouter = Router();

/** The one refusal shape this router uses, so every failure reads the same. */
function fail(
  res: Response,
  status: number,
  message: string,
  userMessage: string,
  extra: Record<string, unknown> = {},
): void {
  res.status(status).json({
    error: {
      code: status >= 500 ? "PROVIDER_UNAVAILABLE" : "INVALID_REQUEST",
      domain: status >= 500 ? "server" : "client",
      message,
      userMessage,
    },
    ...extra,
  });
}

/**
 * The slug, or nothing — having already answered the request.
 *
 * Shared by all four handlers so none of them can be the one that forgets: an
 * unchecked slug reaches `{slug}:{version}` as a document id, and the publish
 * path writes with it.
 */
function slugFrom(req: Request, res: Response): string | null {
  const slug = req.params.slug;
  if (isSlug(slug)) return slug;
  fail(res, 400, "slug must be a language slug", "That language is not available.");
  return null;
}

contentRouter.get("/content/:slug", diagnosticsLimiter, (req, res) => {
  const slug = slugFrom(req, res);
  if (slug === null) return;

  readLatest(slug)
    .then((content) => {
      if (content === null) {
        /**
         * Nothing published, or what is published failed validation. Both mean
         * the same thing to a client — use the bundled set — so both answer
         * the same way rather than making the client distinguish an empty
         * database from a broken one.
         */
        fail(
          res,
          404,
          `no published content for ${slug}`,
          "Using the activities built into the app.",
        );
        return;
      }

      res.json({
        slug: content.slug,
        code: content.code,
        label: content.label,
        version: content.version,
        activities: content.activities,
      });
    })
    .catch((err: unknown) => {
      logger.error({ err, slug }, "[content] request failed");
      fail(res, 503, "could not read content", "Using the activities built into the app.");
    });
});

/**
 * The version history for one language — what the authoring screen lists.
 *
 * Summaries rather than whole sets: the screen needs to know what exists and
 * how old it is before it knows which one anybody wants to open, and shipping
 * fifty full sets to answer that is fifty times the payload for none of the
 * information.
 */
contentRouter.get(
  "/content/:slug/versions",
  // Limiter first, matching the diagnostics router: the token check is cheap,
  // but an unauthenticated flood of it should still be bounded.
  diagnosticsLimiter,
  requireDiagnosticsToken,
  (req: Request, res: Response) => {
    const slug = slugFrom(req, res);
    if (slug === null) return;

    getDb()
      .then((db) => listVersions(db, slug))
      .then((versions) => {
        // An empty list is the honest answer for a language nobody has
        // published, not a 404: the screen's next move is to offer the bundled
        // set as a starting point, and it needs to be told there is nothing
        // rather than that the request failed.
        res.json({ slug, versions });
      })
      .catch((err: unknown) => {
        logger.error({ err, slug }, "[content] version list failed");
        fail(res, 503, "could not list versions", "Could not reach the content database.");
      });
  },
);

/**
 * One published version, whole, for loading into the editor.
 *
 * Unvalidated on the way out — see `readVersion`. A set that fails validation
 * is exactly the one somebody needs to open and repair, so hiding it here
 * would leave no way to fix it but a database client, which is the problem
 * this screen exists to remove.
 */
contentRouter.get(
  "/content/:slug/versions/:version",
  diagnosticsLimiter,
  requireDiagnosticsToken,
  (req: Request, res: Response) => {
    const slug = slugFrom(req, res);
    if (slug === null) return;

    const version = Number(req.params.version);
    if (!Number.isInteger(version) || version < 1) {
      fail(res, 400, "version must be a whole number of 1 or more", "That version does not exist.");
      return;
    }

    getDb()
      .then((db) => readVersion(db, slug, version))
      .then((doc) => {
        if (doc === null) {
          fail(res, 404, `no version ${version} for ${slug}`, "That version does not exist.");
          return;
        }
        res.json({
          slug: doc.slug,
          code: doc.code,
          label: doc.label,
          version: doc.version,
          publishedAt: doc.publishedAt,
          activities: doc.activities,
        });
      })
      .catch((err: unknown) => {
        logger.error({ err, slug, version }, "[content] version read failed");
        fail(res, 503, "could not read version", "Could not reach the content database.");
      });
  },
);

/**
 * Publish a set as the next version. The only write in the product that
 * changes what a learner is asked to say.
 *
 * **The version is the server's to assign, never the body's.** A request that
 * could name its own version could name one that already exists, or skip to 99
 * and strand every later correction behind a gap. So the body carries
 * `baseVersion` instead — *the newest version the author had seen* — and the
 * server publishes `current + 1` only if those still agree.
 *
 * That check is what stops the plain lost update: two people open the screen,
 * both edit from version 3, and without it the second publish becomes version
 * 5 and the first person's corrections are simply gone from the newest set
 * while looking published. A 409 sends the second author back to re-read.
 *
 * `baseVersion` is the *latest seen*, not the version loaded into the editor,
 * which is what keeps rollback working: opening version 2 while 3 is current
 * and publishing it forward as 4 is the documented way to roll back, and it
 * must not read as a conflict with itself.
 */
contentRouter.post(
  "/content/:slug",
  diagnosticsLimiter,
  requireDiagnosticsToken,
  (req: Request, res: Response) => {
    const slug = slugFrom(req, res);
    if (slug === null) return;

    const body: Record<string, unknown> =
      typeof req.body === "object" && req.body !== null
        ? (req.body as Record<string, unknown>)
        : {};

    const baseVersion = body["baseVersion"];
    if (typeof baseVersion !== "number" || !Number.isInteger(baseVersion) || baseVersion < 0) {
      fail(
        res,
        400,
        "baseVersion must be the whole number of the newest version you have seen",
        "Reload the version list and try again.",
      );
      return;
    }

    /**
     * The slug comes from the path, never the body. Two sources for one value
     * is a way to publish French content under the Spanish slug, and the path
     * is the one already checked.
     */
    const draft = readDraft({
      slug,
      code: body["code"],
      label: body["label"],
      activities: body["activities"],
    });

    if (!draft.ok) {
      /**
       * 422 rather than 400: the request was understood, the set is not
       * publishable. `problems` is the point of the response — an author who is
       * told only "invalid" is back to needing an engineer, which is the whole
       * thing this screen removes.
       */
      fail(res, 422, "the set is not publishable", "Fix the problems listed and try again.", {
        problems: draft.problems,
      });
      return;
    }

    void (async (): Promise<void> => {
      try {
        const db = await getDb();
        const current = await latestVersion(db, slug);

        if (baseVersion !== current) {
          fail(
            res,
            409,
            `baseVersion ${baseVersion} is not the current version ${current}`,
            "Somebody else published while you were editing. Reload to see their version.",
            { currentVersion: current },
          );
          return;
        }

        const doc = await publish(db, draft.set, current + 1);
        logger.info(
          { slug, version: doc.version, activities: doc.activities.length },
          "[content] published",
        );

        res.status(201).json({
          slug: doc.slug,
          version: doc.version,
          publishedAt: doc.publishedAt,
          activityCount: doc.activities.length,
        });
      } catch (err: unknown) {
        /**
         * A duplicate key means somebody published the same version between the
         * read above and this write. Same answer as the `baseVersion` mismatch,
         * because it is the same situation caught a moment later — and reported
         * as a conflict rather than a 503, so an author is told to reload
         * instead of believing the database is down.
         */
        if ((err as { code?: unknown }).code === 11000) {
          fail(
            res,
            409,
            "that version was published while this request was in flight",
            "Somebody else published at the same moment. Reload to see their version.",
          );
          return;
        }
        logger.error({ err, slug }, "[content] publish failed");
        fail(res, 503, "could not publish", "Could not reach the content database.");
      }
    })();
  },
);
