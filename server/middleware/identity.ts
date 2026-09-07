/**
 * Resolves the learner behind a request, or refuses it.
 *
 * The learner id lives on `res.locals` rather than on the request via global
 * type augmentation. Augmenting Express's own Request declaration makes every
 * handler in the project look as though it always has a learner, including the
 * ones that never run this middleware — so the type would be lying exactly
 * where it matters. `learnerIdFrom` is the only way to read it, and it returns
 * null rather than asserting.
 */

import type { Request, Response, NextFunction } from "express";
import { bearerFrom, identityConfigured, verifyToken } from "../identity.js";
import { touchLearner } from "../data/learners.js";
import { logger } from "../logger.js";

/** The learner this request proved it is, or null. */
export function learnerIdFrom(res: Response): string | null {
  const value = (res.locals as { learnerId?: unknown }).learnerId;
  return typeof value === "string" ? value : null;
}

function reject(res: Response, message: string): void {
  res.status(401).json({
    error: {
      code: "UNAUTHENTICATED",
      domain: "client",
      message,
      userMessage: "Please reload the page and try again.",
    },
  });
}

/**
 * Refuses anything without a valid token.
 *
 * The failure reason is logged but never returned. "Expired" versus "bad
 * signature" tells an attacker which half of a guess was right, and the client
 * does the same thing either way: mint a new id and register again.
 */
export function requireLearner(req: Request, res: Response, next: NextFunction): void {
  if (!identityConfigured()) {
    res.status(503).json({
      error: {
        code: "MISCONFIGURED",
        domain: "server",
        message: "LEARNER_TOKEN_SECRET is not set",
        userMessage: "This feature is not available right now.",
      },
    });
    return;
  }

  const token = bearerFrom(req.headers.authorization);
  if (token === null) {
    reject(res, "missing bearer token");
    return;
  }

  const result = verifyToken(token);
  if (!result.ok) {
    logger.warn({ reason: result.reason }, "[identity] rejected a token");
    reject(res, "invalid bearer token");
    return;
  }

  res.locals.learnerId = result.learnerId;
  // Fire-and-forget: bookkeeping must not delay or fail the request.
  void touchLearner(result.learnerId);
  next();
}

/**
 * Attaches the learner when there is one, and never refuses.
 *
 * For routes that work with or without an identity — scoring is the case that
 * matters, because a learner who has not registered must still be able to
 * practise, and attributing the attempt is a bonus rather than a requirement.
 */
export function optionalLearner(req: Request, res: Response, next: NextFunction): void {
  if (!identityConfigured()) {
    next();
    return;
  }

  const token = bearerFrom(req.headers.authorization);
  if (token !== null) {
    const result = verifyToken(token);
    if (result.ok) res.locals.learnerId = result.learnerId;
    else logger.warn({ reason: result.reason }, "[identity] ignored an invalid token");
  }
  next();
}
