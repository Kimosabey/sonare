/**
 * Who is asking, not merely whether they hold a token.
 *
 * `requireDiagnosticsToken` checks one shared secret from the environment and
 * then hands the request on. Every teacher surface sat behind it and then read
 * whichever `classId` arrived in the path, so a holder of that token could
 * read **every class on the server** — another teacher's, another school's.
 *
 * That was contained only because nothing linked to the board: the sole holder
 * was the operator. Handing teachers the link, which is the whole point of
 * giving them a way in, is what would have turned it into a breach. The
 * product's second-strongest claim is about what a teacher may see; "any
 * teacher may see every class" is the kind of sentence a school's data officer
 * asks about directly.
 *
 * So a class now has an owner, and a teacher presents a key for it.
 *
 * ## The operator still gets through
 *
 * `DIAGNOSTICS_TOKEN` remains sufficient, deliberately. Somebody has to be
 * able to administer a deployment, classes created before ownership existed
 * have no owner to present a key for, and a support conversation about a class
 * nobody can open is worse than the risk this closes. The difference is that
 * it is now *one* holder by design rather than everyone by accident.
 */

import type { NextFunction, Request, Response } from "express";
import { ownsClass } from "../store/classes.js";
import { logger } from "../logger.js";

/** The header a teacher presents. Distinct from the operator's. */
export const TEACHER_KEY_HEADER = "x-teacher-key";

function operatorTokenMatches(req: Request): boolean {
  const required = process.env.DIAGNOSTICS_TOKEN;
  const provided = req.headers["x-diagnostics-token"];
  // Same fail-closed posture as requireDiagnosticsToken: unset is not open.
  return Boolean(required) && typeof provided === "string" && provided === required;
}

/**
 * Refuses unless the caller owns this class, or is the operator.
 *
 * Mounted *after* `requireDiagnosticsToken` on routes that address a class, so
 * an unauthenticated caller is refused before this runs and never learns
 * whether a class exists.
 */
export function requireClassOwner(req: Request, res: Response, next: NextFunction): void {
  const classId = String(req.params.classId ?? "");
  const header = req.headers[TEACHER_KEY_HEADER];
  const key = typeof header === "string" && header !== "" ? header : null;

  if (operatorTokenMatches(req)) {
    next();
    return;
  }

  void ownsClass(classId, key)
    .then((owns) => {
      if (owns) {
        next();
        return;
      }
      /**
       * 404, not 403, and the wording says nothing either.
       *
       * A 403 on a class that exists and a 404 on one that does not is an
       * oracle: a caller with any key could walk class ids and learn which are
       * real. The one thing this guard exists to stop is reading across
       * classes, and confirming their existence is the first half of that.
       */
      logger.warn({ classId }, "[classes] refused: caller does not own this class");
      res.status(404).json({
        error: {
          code: "NOT_FOUND",
          domain: "client",
          message: "no such class",
          userMessage: "That class does not exist.",
        },
      });
    })
    .catch((err: unknown) => {
      // A store failure must refuse rather than fall through to the handler.
      logger.error({ err, classId }, "[classes] ownership check failed");
      res.status(503).json({
        error: {
          code: "UNAVAILABLE",
          domain: "server",
          message: "could not check class ownership",
          userMessage: "Couldn’t reach the server. Please try again.",
        },
      });
    });
}
