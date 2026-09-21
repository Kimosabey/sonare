/**
 * Classes: creating one, previewing one by code, and a pupil joining it.
 *
 * The routes split along the line the Teacher board draws. Creating a class
 * and reading its summary are the teacher's, behind the same token the other
 * operator surfaces use. Previewing and joining are the pupil's, and joining
 * is the only write in this file that touches membership — there is no
 * endpoint by which a teacher adds a pupil, because the board's identity model
 * has no list for one to add to.
 *
 * `GET /classes/:id/summary` is the interesting one. It reads every member's
 * skills, turns each accuracy into a standing **before** the class boundary
 * (`classStanding.ts`), and hands the standings to `summariseClass`. No
 * accuracy is in scope after that conversion, so the response cannot carry one
 * even by accident — which is the property `promise.test.ts` and
 * `classSummary.test.ts` both assert from their own side.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { diagnosticsLimiter } from "../rateLimit.js";
import { requireDiagnosticsToken } from "./diagnostics.js";
import { requireClassOwner } from "../middleware/classOwner.js";
import { requireLearner, learnerIdFrom } from "../middleware/identity.js";
import { isSlug } from "../domain/merge.js";
import { logger } from "../logger.js";
import {
  createClass,
  joinClass,
  leaveClass,
  membersOf,
  membershipsFor,
  previewByCode,
  readClass,
  readSuggestion,
  regenerateCode,
  setSharedName,
  suggestSitting,
} from "../store/classes.js";
import { readSkills } from "../store/skills.js";
import { readProgress } from "../store/progress.js";
import { standingsFor, takesFor } from "../domain/classStanding.js";
import { buildRoster, type PupilRecord } from "../domain/classRoster.js";
import { summariseClass, type PupilPractice } from "../domain/classSummary.js";

export const classesRouter = Router();

function fail(res: Response, status: number, error: string, userMessage: string): void {
  res.status(status).json({ error: { error, userMessage } });
}

/** A teacher creating a class. Returns the join code once and never again. */
classesRouter.post(
  "/classes",
  diagnosticsLimiter,
  requireDiagnosticsToken,
  (req: Request, res: Response) => {
    const body = req.body as {
      name?: unknown;
      teacherName?: unknown;
      slug?: unknown;
      expectedCount?: unknown;
    };

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const teacherName = typeof body.teacherName === "string" ? body.teacherName.trim() : "";
    const slug = typeof body.slug === "string" ? body.slug : "";

    if (name === "" || teacherName === "" || !isSlug(slug)) {
      fail(res, 400, "name, teacherName and a valid slug are required", "Check the class details.");
      return;
    }

    const expectedCount =
      typeof body.expectedCount === "number" && Number.isInteger(body.expectedCount)
        ? Math.max(0, body.expectedCount)
        : null;

    createClass({ name, teacherName, slug, expectedCount })
      .then((created) => res.status(201).json(created))
      .catch((err: unknown) => {
        logger.error({ err }, "[classes] create failed");
        fail(res, 503, "could not create the class", "Could not reach the database.");
      });
  },
);

classesRouter.post(
  "/classes/:classId/code",
  diagnosticsLimiter,
  requireDiagnosticsToken,
  // Checks who is asking, not only that they hold a token — see classOwner.ts.
  requireClassOwner,
  (req: Request, res: Response) => {
    regenerateCode(String(req.params.classId))
      .then((code) => {
        if (code === null) {
          fail(res, 404, "no such class", "That class does not exist.");
          return;
        }
        res.json({ code });
      })
      .catch((err: unknown) => {
        logger.error({ err }, "[classes] regenerate failed");
        fail(res, 503, "could not regenerate", "Could not reach the database.");
      });
  },
);

/**
 * What a pupil is shown before deciding.
 *
 * Unauthenticated by necessity — a pupil typing a code off a board has no
 * relationship with the class yet. It returns the class's own name, the
 * teacher's name and the language, and deliberately **not** how many have
 * joined: that is a fact about other pupils, and the pupil asking has agreed
 * to nothing at this point.
 *
 * The code goes in the body rather than the URL even though this is a read,
 * for the same reason `deviceLink.ts` does it: a query string reaches server
 * logs, proxy logs and browser history.
 */
classesRouter.post("/classes/preview", diagnosticsLimiter, (req: Request, res: Response) => {
  const body = req.body as { code?: unknown };

  previewByCode(body.code)
    .then((preview) => {
      if (preview === null) {
        fail(res, 404, "no such code", "That code does not match a class. Check it and try again.");
        return;
      }
      res.json(preview);
    })
    .catch((err: unknown) => {
      logger.error({ err }, "[classes] preview failed");
      fail(res, 503, "could not look up the code", "Could not reach the server.");
    });
});

/** A pupil attaching themselves. The only route that adds a membership. */
classesRouter.post(
  "/classes/join",
  diagnosticsLimiter,
  requireLearner,
  (req: Request, res: Response) => {
    const learnerId = learnerIdFrom(res);
    if (learnerId === null) {
      fail(res, 401, "no learner", "Sign in on this device first.");
      return;
    }

    const body = req.body as { code?: unknown; sharedName?: unknown };
    // Null rather than absent when a pupil joins without a name, so the choice
    // is recorded rather than looking like a field somebody forgot to send.
    const sharedName =
      typeof body.sharedName === "string" && body.sharedName.trim() !== ""
        ? body.sharedName.trim()
        : null;

    joinClass(body.code, learnerId, sharedName)
      .then((outcome) => {
        if (!outcome.ok) {
          fail(res, 404, "no such code", "That code does not match a class.");
          return;
        }
        res.status(outcome.alreadyMember ? 200 : 201).json({
          classId: outcome.classId,
          alreadyMember: outcome.alreadyMember,
        });
      })
      .catch((err: unknown) => {
        logger.error({ err }, "[classes] join failed");
        fail(res, 503, "could not join", "Could not reach the server.");
      });
  },
);

classesRouter.delete(
  "/classes/:classId/membership",
  diagnosticsLimiter,
  requireLearner,
  (req: Request, res: Response) => {
    const learnerId = learnerIdFrom(res);
    if (learnerId === null) {
      fail(res, 401, "no learner", "Sign in on this device first.");
      return;
    }

    leaveClass(String(req.params.classId), learnerId)
      .then((left) => res.json({ left }))
      .catch((err: unknown) => {
        logger.error({ err }, "[classes] leave failed");
        fail(res, 503, "could not leave", "Could not reach the server.");
      });
  },
);

/**
 * The class summary a teacher's screen renders.
 *
 * Every accuracy becomes a standing inside this handler and nothing else
 * crosses. The learner ids are used to gather practice and are not in the
 * response — `summariseClass` returns counts, and its tests assert no
 * identifier survives.
 */
classesRouter.get(
  "/classes/:classId/summary",
  diagnosticsLimiter,
  requireDiagnosticsToken,
  // Checks who is asking, not only that they hold a token — see classOwner.ts.
  requireClassOwner,
  (req: Request, res: Response) => {
    const classId = String(req.params.classId);

    readClass(classId)
      .then(async (klass) => {
        if (klass === null) {
          fail(res, 404, "no such class", "That class does not exist.");
          return;
        }

        const members = await membersOf(classId);
        const practice: PupilPractice[] = [];
        /**
         * Board 1g's list, built in the same pass. It names pupils and carries
         * no figure — `buildRoster` reads the skills and emits graphemes, so
         * the accuracies stop here exactly as they do for the summary.
         */
        const records: PupilRecord[] = [];

        for (const member of members) {
          const [skills, progress] = await Promise.all([
            readSkills(member.learnerId, klass.slug),
            readProgress(member.learnerId, klass.slug),
          ]);

          practice.push({
            pupilId: member.learnerId,
            standing: standingsFor(skills?.skills ?? []),
            takes: takesFor(skills?.skills ?? []),
            // Days come from progress timestamps: the date part of the most
            // recent attempt on each activity. Attendance is "did they turn
            // up", which is exactly what a dated attempt records.
            days: [...new Set((progress?.entries ?? []).map((entry) => entry.at.slice(0, 10)))],
          });

          records.push({
            learnerId: member.learnerId,
            sharedName: member.sharedName,
            skills: skills?.skills ?? [],
            progress: progress?.entries ?? [],
          });
        }

        res.json({
          className: klass.name,
          slug: klass.slug,
          expectedCount: klass.expectedCount,
          summary: summariseClass(practice),
          roster: buildRoster(records),
        });
      })
      .catch((err: unknown) => {
        logger.error({ err, classId }, "[classes] summary failed");
        fail(res, 503, "could not build the summary", "Could not reach the database.");
      });
  },
);

/**
 * A teacher suggesting a sitting to their class.
 *
 * Replaces whatever was suggested before rather than queueing behind it — see
 * the store. Nothing about this is scheduled or enforced; the route stores a
 * lesson id and the teacher's own phrase for when.
 */
classesRouter.post(
  "/classes/:classId/suggestion",
  diagnosticsLimiter,
  requireDiagnosticsToken,
  // Checks who is asking, not only that they hold a token — see classOwner.ts.
  requireClassOwner,
  (req: Request, res: Response) => {
    const classId = String(req.params.classId);
    const body = req.body as { lessonId?: unknown; window?: unknown };

    const lessonId = typeof body.lessonId === "number" ? body.lessonId : Number.NaN;
    if (!Number.isInteger(lessonId) || lessonId < 1) {
      fail(res, 400, "lessonId must be a whole number of 1 or more", "Could not set that sitting.");
      return;
    }

    // The window is stored as the teacher's words. Refused rather than
    // defaulted if it is not one of them, because a suggestion that silently
    // became "this week" would put a deadline on a screen that promises none.
    const windows = ["this-week", "before-next-lesson", "no-particular-time"];
    const window = typeof body.window === "string" ? body.window : "";
    if (!windows.includes(window)) {
      fail(res, 400, "window must be one of the three offered", "Could not set that sitting.");
      return;
    }

    readClass(classId)
      .then(async (klass) => {
        if (klass === null) {
          fail(res, 404, "no such class", "That class does not exist.");
          return;
        }
        await suggestSitting(classId, lessonId, window);
        res.status(201).json({ lessonId, window });
      })
      .catch((err: unknown) => {
        logger.error({ err, classId }, "[classes] suggest failed");
        fail(res, 503, "could not store the suggestion", "Could not reach the database.");
      });
  },
);

/**
 * What a learner's own classes have suggested — read by their device.
 *
 * Authenticated as the learner and scoped to their memberships, so it can only
 * ever answer about a class they chose to join. It returns the class name
 * alongside the lesson so their Today screen can say who suggested it; a
 * lesson id with no name would be a prompt from nowhere.
 *
 * An empty list is the ordinary answer. Most learners are in no class, and
 * that is not a failure to report.
 */
classesRouter.get(
  "/classes/mine/suggestions",
  diagnosticsLimiter,
  requireLearner,
  (_req: Request, res: Response) => {
    const learnerId = learnerIdFrom(res);
    if (learnerId === null) {
      fail(res, 401, "no learner", "Sign in on this device first.");
      return;
    }

    membershipsFor(learnerId)
      .then(async (memberships) => {
        const suggestions = [];
        for (const membership of memberships) {
          const [klass, suggestion] = await Promise.all([
            readClass(membership.classId),
            readSuggestion(membership.classId),
          ]);
          if (klass === null || suggestion === null) continue;
          suggestions.push({
            classId: membership.classId,
            className: klass.name,
            teacherName: klass.teacherName,
            slug: klass.slug,
            lessonId: suggestion.lessonId,
            window: suggestion.window,
          });
        }
        res.json({ suggestions });
      })
      .catch((err: unknown) => {
        logger.error({ err }, "[classes] reading suggestions failed");
        fail(res, 503, "could not read suggestions", "Could not reach the server.");
      });
  },
);

/**
 * The classes this learner is in, as their own device sees them — board 1h's
 * pupil-facing mirror.
 *
 * Deliberately returns what the *pupil* needs rather than what the class
 * holds: the class's name, who the teacher is, when they joined and the name
 * they are sharing. No other pupil appears, and neither does anything about
 * the group — a learner asking about their own membership is not asking about
 * their classmates.
 */
classesRouter.get(
  "/classes/mine",
  diagnosticsLimiter,
  requireLearner,
  (_req: Request, res: Response) => {
    const learnerId = learnerIdFrom(res);
    if (learnerId === null) {
      fail(res, 401, "no learner", "Sign in on this device first.");
      return;
    }

    membershipsFor(learnerId)
      .then(async (memberships) => {
        const classes = [];
        for (const membership of memberships) {
          const klass = await readClass(membership.classId);
          if (klass === null) continue;
          classes.push({
            classId: membership.classId,
            className: klass.name,
            teacherName: klass.teacherName,
            slug: klass.slug,
            joinedAt: membership.joinedAt.toISOString().slice(0, 10),
            sharedName: membership.sharedName,
          });
        }
        res.json({ classes });
      })
      .catch((err: unknown) => {
        logger.error({ err }, "[classes] reading memberships failed");
        fail(res, 503, "could not read your classes", "Could not reach the server.");
      });
  },
);

/**
 * Removing the name a pupil shares, without leaving the class.
 *
 * Only ever *removes*. There is no way through this route to set a name the
 * pupil did not choose on the join screen — the body is not read for one,
 * because the one thing this must not become is a place a name can be put
 * back after somebody took it off.
 */
classesRouter.delete(
  "/classes/:classId/name",
  diagnosticsLimiter,
  requireLearner,
  (req: Request, res: Response) => {
    const learnerId = learnerIdFrom(res);
    if (learnerId === null) {
      fail(res, 401, "no learner", "Sign in on this device first.");
      return;
    }

    setSharedName(String(req.params.classId), learnerId, null)
      .then((changed) => {
        if (!changed) {
          fail(res, 404, "not a member", "You are not in that class.");
          return;
        }
        res.json({ sharedName: null });
      })
      .catch((err: unknown) => {
        logger.error({ err }, "[classes] removing a shared name failed");
        fail(res, 503, "could not remove your name", "Could not reach the server.");
      });
  },
);
