/**
 * What to practise next.
 *
 * Returns the learner's **due sounds**, weakest first, and — when it can — the
 * activity that drills the most of them. Both halves come from the syllable
 * history the scoring path accumulates, and this is the part of the scheduler
 * only the server can do: it needs the whole history across every session and
 * device, which is exactly what the client does not have on a fresh install.
 *
 * ## Why the pick is called a refinement
 *
 * The client composes its own sitting, always, offline included
 * (`src/learning/composeSession.ts`). This endpoint's `refinement` is an
 * **input** to that composition, never an alternative to it: it may change the
 * order of the sitting, and it may not change which activities are in it or
 * which sounds are due. The wire field is named for what a client may do with
 * it rather than for what this file computed, because "selection" would invite
 * exactly the reading the design forbids.
 *
 * Two implementations of "what next" is the shape that drifts silently, and a
 * learner finds out by watching their session change when they come online.
 * `composeSession.contract.test.ts` holds the composer to ordering-only, and
 * `next.contract.test.ts` drives this route and feeds its reply straight into
 * the composer — so neither side can rename a field without going red.
 *
 * ## What it refuses to guess
 *
 * A pick needs two things beyond the schedule: which syllables each activity
 * exercises, and what this learner has already done. Both can be missing, and
 * neither is an error:
 *
 *  - **Nothing published for this language.** The client is reading its
 *    bundled set, which lives in `src/activities/` and which this process does
 *    not import — so there is no grapheme mapping to select over.
 *  - **Progress unreadable.** Not the same as a learner with no progress. A
 *    fresh learner genuinely has nothing attempted and `unpractised` is true
 *    of them; treating an unreadable document as the same thing would offer a
 *    learner thirty activities in the word "recommended".
 *
 * In both cases `activitySelected` is false and the sounds still go back. The
 * sounds are the half the client could not have worked out for itself, and
 * withholding them because the other half failed would make one degraded read
 * into two.
 */

import { Router } from "express";
import { requireLearner, learnerIdFrom } from "../middleware/identity.js";
import { diagnosticsLimiter } from "../rateLimit.js";
import { logger } from "../logger.js";
import { isSlug } from "../domain/merge.js";
import {
  dueSounds,
  scheduleFor,
  selectActivity,
  type SchedulableActivity,
  type Selection,
  type SkillSchedule,
} from "../domain/scheduler.js";
import { readSkills } from "../store/skills.js";
import { readLatest, type ContentActivity, type ContentDocument } from "../store/content.js";
import { readProgress } from "../store/progress.js";

export const nextRouter = Router();

/**
 * How many sounds to return.
 *
 * A learner cannot act on twenty at once, and a screen that lists them all
 * turns a next step into a report card. The full schedule is available to the
 * progress view; this endpoint answers "what now".
 */
const MAX_DUE = 5;

interface NextSchedule {
  slug: string;
  /** Due now, weakest first. Empty when nothing is due, which is not an error. */
  due: SkillSchedule[];
  /**
   * Everything known about this language's sounds, weakest first — including
   * what is not yet due, so a progress view needs no second request.
   */
  all: SkillSchedule[];
}

/**
 * A union rather than an optional field, so `activitySelected` and
 * `refinement` cannot disagree. A boolean beside an optional object has four
 * states and only two of them mean anything; a client reading the true branch
 * gets a refinement from the type system rather than from a comment.
 *
 * `activitySelected` stays named rather than omitted on the false branch: a
 * client can tell "the server had nothing to add" from "an older server that
 * does not answer this" without inferring either from a missing key.
 */
export type NextResponse =
  | (NextSchedule & { activitySelected: false })
  | (NextSchedule & {
      activitySelected: true;
      /**
       * `Selection` verbatim, deliberately. Restating it as a wire type would
       * be a second definition to keep in step, and its three fields are
       * exactly what `SessionRefinement` accepts on the client — which is a
       * structural coincidence only until next.contract.test.ts holds it.
       */
      refinement: Selection;
    });

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
    .then(async (state) => {
      const skills = state?.skills ?? [];
      // One clock for the whole response, so `due` and `all` cannot disagree
      // about whether a sound is due when the request straddles midnight.
      const now = new Date();

      const all = skills
        .map((skill) => scheduleFor(skill, now))
        .sort((a, b) => a.strength - b.strength || (a.grapheme < b.grapheme ? -1 : 1));

      /**
       * Selection reads the **whole** due list; the response shows the top
       * few. `MAX_DUE` is a display limit — a learner cannot act on twenty
       * sounds at once — and applying it before selecting would make an
       * activity that drills six due sounds look like it drills two, and lose
       * to a narrower one. The two lists answer different questions.
       */
      const due = dueSounds(skills, now);
      const refinement = await refinementFor(learnerId, slug, due);

      const schedule = { slug, due: due.slice(0, MAX_DUE), all };
      const body: NextResponse =
        refinement === null
          ? { ...schedule, activitySelected: false }
          : { ...schedule, activitySelected: true, refinement };
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

/**
 * The activities the course actually offers.
 *
 * A set with a spine gets filtered to what its lessons reference, because the
 * publish gate only requires `soundTargets` of an activity a lesson points at.
 * Selecting over the flat list instead would let the `unpractised` fallback
 * reach past the course into an activity no lesson leads to — a learner
 * following a journey being handed something outside it, labelled as the next
 * thing to do.
 *
 * A set with no spine is the flat list, in order, which is the shape that
 * shipped and the one the client is reading when there is no spine to read.
 */
function offeredBy(content: ContentDocument): ContentActivity[] {
  if (content.units === undefined) return content.activities;

  const referenced = new Set(
    content.units.flatMap((unit) => unit.lessons.flatMap((lesson) => lesson.activityIds)),
  );
  return content.activities.filter((activity) => referenced.has(activity.id));
}

/**
 * The server's pick, or null when it has no business making one.
 *
 * Never throws and never rejects: the caller's `.catch` is the 503 for an
 * unreadable *schedule*, and a failure here must not spend it. Losing the pick
 * costs an ordering; losing the response costs the sounds as well.
 */
async function refinementFor(
  learnerId: string,
  slug: string,
  due: SkillSchedule[],
): Promise<Selection | null> {
  // Already returns null rather than throwing on a bad read, and logs its own
  // reason — see store/content.ts.
  const content = await readLatest(slug);
  if (content === null) return null;

  let entries;
  try {
    // `null` is a learner who has attempted nothing, and is not a failure —
    // only a throw is. See the file comment on why the two must not collapse.
    entries = (await readProgress(learnerId, slug))?.entries ?? [];
  } catch (err) {
    logger.warn({ err, learnerId, slug }, "[next] progress unreadable, so not choosing an activity");
    return null;
  }

  const byActivity = new Map(entries.map((entry) => [entry.activityId, entry]));

  const schedulable = offeredBy(content).map<SchedulableActivity>((activity) => {
    const entry = byActivity.get(activity.id);
    return {
      id: activity.id,
      /**
       * Already folded to the same lower case the skills store keys on, by
       * readActivity. Absent on a set published before the field existed,
       * which selectActivity handles as "fallback only".
       *
       * A `listen` activity is put in that same position deliberately, even
       * when it names sound targets — and it legitimately does, because
       * hearing `poisson` against `poison` is about exactly those sounds.
       * The trouble is that answering it produces no recording, so no sample
       * reaches the skills store and the sound's strength cannot move. Offer
       * it against a due sound and it is still due tomorrow, and the same
       * activity wins again, every day, with the learner never once asked to
       * say the word. Its targets stay in the document; they just cannot
       * satisfy a due sound.
       */
      graphemes: activity.kind === "listen" ? [] : (activity.soundTargets ?? []),
      passed: entry?.passed ?? false,
      lastAttemptAt: entry?.at ?? null,
    };
  });

  return selectActivity(schedulable, due);
}
