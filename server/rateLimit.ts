/**
 * Rate limits — this endpoint is an open proxy to a metered Azure API with
 * no auth in front of it (PRD.md: "no new authentication — the app has it,"
 * true for the learner flow this ships inside, not for a standalone
 * exposure like the ngrok-tunneled dev server this session used). Without a
 * cap, anyone who finds the URL can run up the Azure bill.
 *
 * Both limiters are backed by MongoRateLimitStore rather than the library's
 * in-memory default, which reset on every restart and gave each additional
 * instance its own full budget. Each limiter gets its own namespace so they do
 * not share a count — the tighter one would otherwise starve the looser.
 */

import rateLimit from "express-rate-limit";
import { MongoRateLimitStore } from "./rateLimitStore.js";
import { learnerIdFrom } from "./middleware/identity.js";

/** Generous for real use — 3 scored tries × 10 activities is 30 calls in a
    session, spread over minutes, not seconds. Tight enough to block a script. */
/**
 * The per-IP ceiling, for callers we cannot identify.
 *
 * **Skipped once a request carries a valid learner token**, and that is a fix
 * rather than a loophole. A per-IP limit is what causes the classroom problem:
 * twenty students behind one NAT share thirty requests a minute and lock each
 * other out, having done nothing wrong. An identified learner is bounded by
 * their own limiter below, which is both fairer and tighter than a budget
 * split twenty ways by accident.
 *
 * `optionalLearner` therefore has to run *before* this in the route. It is an
 * HMAC verify and nothing else — no database write — so putting it ahead of
 * rate limiting costs a few microseconds and buys the distinction.
 */
export const scoringLimiter = rateLimit({
  store: new MongoRateLimitStore("scoring"),
  skip: (_req, res) => learnerIdFrom(res) !== null,
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", domain: "client", message: "too many scoring requests", userMessage: "Please slow down and try again in a moment." } },
});

/** Diagnostics reads/writes are cheap (no external API cost) — this is
    about abuse volume, not billing, so the ceiling is looser. */
export const diagnosticsLimiter = rateLimit({
  store: new MongoRateLimitStore("diagnostics"),
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * The per-learner ceiling.
 *
 * Twenty a minute. A take needs a couple of seconds of speech and a second
 * and a half of scoring, so the physical ceiling for a person is somewhere
 * near seventeen — twenty sits just above what a human can do and far below
 * what a script can, which is the shape a limit on a metered API wants.
 *
 * Keyed on the learner rather than the address, so it follows them between
 * networks and does not punish whoever shares theirs. Skipped for an
 * anonymous request, which the per-IP limiter above already covers: applying
 * both would mean a caller with no token counted twice against two budgets.
 *
 * Its own namespace, so it never shares a count with the per-IP limiter.
 */
export const perLearnerScoringLimiter = rateLimit({
  store: new MongoRateLimitStore("scoring-learner"),
  keyGenerator: (_req, res) => learnerIdFrom(res) ?? "anonymous",
  skip: (_req, res) => learnerIdFrom(res) === null,
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: "RATE_LIMITED",
      domain: "client",
      // Deliberately the same wording as the per-IP refusal. Which limiter
      // fired is our business, and telling a learner they personally are
      // being throttled invites them to think their account is in trouble.
      message: "too many scoring requests",
      userMessage: "Please slow down and try again in a moment.",
    },
  },
});
