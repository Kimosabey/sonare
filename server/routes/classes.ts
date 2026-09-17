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
import { requireLearner, learnerIdFrom } from "../middleware/identity.js";
import { isSlug } from "../domain/merge.js";
import { logger } from "../logger.js";
import {
  createClass,
  joinClass,
  leaveClass,
  membersOf,
  previewByCode,
  readClass,
  regenerateCode,
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
