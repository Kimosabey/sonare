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
 */

import { Router } from "express";
import { diagnosticsLimiter } from "../rateLimit.js";
import { isSlug } from "../domain/merge.js";
import { readLatest } from "../store/content.js";
import { logger } from "../logger.js";

export const contentRouter = Router();

contentRouter.get("/content/:slug", diagnosticsLimiter, (req, res) => {
  const slug = req.params.slug;

  if (!isSlug(slug)) {
    res.status(400).json({
      error: {
        code: "INVALID_REQUEST",
        domain: "client",
        message: "slug must be a language slug",
        userMessage: "That language is not available.",
      },
    });
    return;
  }

  readLatest(slug)
    .then((content) => {
      if (content === null) {
        /**
         * Nothing published, or what is published failed validation. Both mean
         * the same thing to a client — use the bundled set — so both answer
         * the same way rather than making the client distinguish an empty
         * database from a broken one.
         */
        res.status(404).json({
          error: {
            code: "INVALID_REQUEST",
            domain: "client",
            message: `no published content for ${slug}`,
            userMessage: "Using the activities built into the app.",
          },
        });
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
      res.status(503).json({
        error: {
          code: "PROVIDER_UNAVAILABLE",
          domain: "server",
          message: "could not read content",
          userMessage: "Using the activities built into the app.",
        },
      });
    });
});
