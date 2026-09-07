/**
 * What to practise next.
 *
 * Returns the learner's **due sounds**, weakest first, computed from the
 * syllable history the scoring path has been accumulating. This is the half of
 * the scheduler that only the server can do: it needs the whole history across
 * every session and device, which is exactly what the client does not have on
 * a fresh install.
 *
 * It deliberately does *not* choose the activity yet. Choosing needs to know
 * which syllables each activity exercises, and that mapping only exists where
 * content does — which is still in the client bundle. Once content moves into
 * the database, `selectActivity` (already written and tested in
 * domain/scheduler.ts) moves behind this endpoint and the response gains an
 * `activityId`. Until then the client keeps using its own ordering, and this
 * supplies the thing it could not work out for itself.
 *
 * Saying that plainly matters more than shipping a guess: an `activityId`
 * chosen without the grapheme mapping would be the first-unpassed activity
 * wearing the word "recommended", which is worse than not recommending.
 */

import { Router } from "express";
import { requireLearner, learnerIdFrom } from "../middleware/identity.js";
import { diagnosticsLimiter } from "../rateLimit.js";
import { logger } from "../logger.js";
import { isSlug } from "../domain/merge.js";
import { dueSounds, scheduleFor, type SkillSchedule } from "../domain/scheduler.js";
import { readSkills } from "../store/skills.js";

export const nextRouter = Router();

/**
 * How many sounds to return.
 *
 * A learner cannot act on twenty at once, and a screen that lists them all
 * turns a next step into a report card. The full schedule is available to the
 * progress view; this endpoint answers "what now".
 */
const MAX_DUE = 5;

export interface NextResponse {
  slug: string;
  /** Due now, weakest first. Empty when nothing is due, which is not an error. */
  due: SkillSchedule[];
  /**
   * Everything known about this language's sounds, weakest first — including
   * what is not yet due, so a progress view needs no second request.
   */
  all: SkillSchedule[];
  /**
   * Whether the server chose an activity. Always false for now, and named
   * rather than omitted so a client can tell "not implemented" from "nothing
   * to recommend" without guessing from a missing field.
   */
  activitySelected: false;
}

nextRouter.get("/next", diagnosticsLimiter, requireLearner, (req, res) => {
  const learnerId = learnerIdFrom(res);
  if (learnerId === null) return;

  const slug = req.query["slug"];
  if (!isSlug(slug)) {
    res.status(400).json({
      error: {
        code: "INVALID_REQUEST",
        domain: "client",
        message: "slug query parameter is required and must be a language slug",
        userMessage: "Could not work out what to practise. Please reload and try again.",
      },
    });
    return;
  }

  readSkills(learnerId, slug)
    .then((state) => {
      const skills = state?.skills ?? [];
      // One clock for the whole response, so `due` and `all` cannot disagree
      // about whether a sound is due when the request straddles midnight.
      const now = new Date();

      const all = skills
        .map((skill) => scheduleFor(skill, now))
        .sort((a, b) => a.strength - b.strength || (a.grapheme < b.grapheme ? -1 : 1));

      const body: NextResponse = {
        slug,
        due: dueSounds(skills, now).slice(0, MAX_DUE),
        all,
        activitySelected: false,
      };
      res.json(body);
    })
    .catch((err: unknown) => {
      logger.error({ err, learnerId, slug }, "[next] could not read the schedule");
      res.status(503).json({
        error: {
          code: "PROVIDER_UNAVAILABLE",
          domain: "server",
          message: "could not read the learner's sound history",
          // The client has its own ordering to fall back on, so this is not
          // something the learner needs to act on.
          userMessage: "Carrying on with your usual practice order.",
        },
      });
    });
});
