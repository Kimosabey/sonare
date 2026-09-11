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

/**
 * ── device linking ───────────────────────────────────────────────────────────
 *
 * A link code (linkCodes.ts) is a bearer credential that grants full read,
 * write and delete access to a learner's record, so the claim endpoint is a
 * guessing surface and is limited as one rather than as a cheap read. The
 * numbers here are half of the brute-force arithmetic written out in
 * linkCodes.ts's `CODE_LENGTH`; changing one without the other invalidates it.
 */

/** Exported so the tests assert against the limit in force, not a copy of it. */
export const LINK_CLAIM_WINDOW_MS = 600_000;
export const LINK_CLAIM_PER_ADDRESS_LIMIT = 10;
export const LINK_CLAIM_GLOBAL_WINDOW_MS = 60_000;
export const LINK_CLAIM_GLOBAL_LIMIT = 600;
export const LINK_MINT_WINDOW_MS = 600_000;
export const LINK_MINT_PER_LEARNER_LIMIT = 5;

const LINK_CLAIM_REFUSAL = {
  error: {
    code: "RATE_LIMITED",
    domain: "client",
    message: "too many link attempts",
    userMessage: "Too many attempts. Wait a few minutes, then get a fresh code from your other device.",
  },
};

/**
 * The per-address claim ceiling: ten attempts per ten minutes.
 *
 * Tighter than `diagnosticsLimiter`'s 120 a minute, because a learner typing a
 * code they are looking at needs one attempt and two on a bad day, and
 * anything past ten from one address inside a code's whole lifetime is not a
 * person typing.
 *
 * `diagnosticsLimiter` is deliberately **not** also applied to the claim
 * route, and not because it would be too loose. Both limiters key on the
 * caller's address and both are backed by a `MongoRateLimitStore`, and
 * express-rate-limit treats two increments of one key within a single request
 * as a bug (`ERR_ERL_DOUBLE_COUNT`) — so stacking them would log an error on
 * every claim while adding nothing this limiter does not already do.
 */
export const linkClaimLimiter = rateLimit({
  store: new MongoRateLimitStore("link-claim"),
  windowMs: LINK_CLAIM_WINDOW_MS,
  limit: LINK_CLAIM_PER_ADDRESS_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  message: LINK_CLAIM_REFUSAL,
});

/**
 * The ceiling a botnet cannot step around: 600 wrong codes a minute, total.
 *
 * A per-address limit bounds one attacker and does nothing about ten thousand
 * addresses, which is the shape a credential-guessing attack actually has. So
 * this one is keyed on a constant — every claim in the world counts against
 * one budget — and it is what makes the arithmetic in linkCodes.ts hold
 * against an attacker of unbounded size rather than only against a polite one.
 *
 * `skipSuccessfulRequests` makes it a budget for *wrong* answers. A successful
 * claim is decremented back out, so ordinary use never consumes it and the
 * ceiling is spent only on failures.
 *
 * The cost, stated rather than hidden: a global ceiling is a lever, and an
 * attacker willing to burn 600 attempts a minute can pause device linking for
 * the rest of that minute for everybody. That is accepted knowingly. It
 * suspends a rare, retriable, one-time flow for under a minute, where the
 * alternative is an unbounded guessing surface against a credential that can
 * delete a learner's record — and 600 failures a minute is orders of magnitude
 * above any legitimate volume, so no real learner reaches it.
 */
export const linkClaimGlobalLimiter = rateLimit({
  store: new MongoRateLimitStore("link-claim-all"),
  // One bucket for the whole service. Deliberately not the address, and
  // therefore not subject to the IPv6 helper the default generator needs.
  keyGenerator: () => "all",
  windowMs: LINK_CLAIM_GLOBAL_WINDOW_MS,
  limit: LINK_CLAIM_GLOBAL_LIMIT,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: LINK_CLAIM_REFUSAL,
});

/**
 * The minting ceiling: five codes per learner per ten minutes.
 *
 * Not about cost — minting is one small write. It bounds how fast a learner
 * can churn codes, which matters because each mint retires the last one: a
 * client looping on the button would hand its own learner a stream of codes
 * that die a moment after being shown.
 *
 * Keyed on the learner rather than the address, so it follows them between
 * networks and does not punish a classroom sharing one. That requires
 * `requireLearner` to have run first, which is also what makes `?? "anonymous"`
 * unreachable rather than a shared bucket for strangers.
 */
export const linkMintLimiter = rateLimit({
  store: new MongoRateLimitStore("link-mint"),
  keyGenerator: (_req, res) => learnerIdFrom(res) ?? "anonymous",
  windowMs: LINK_MINT_WINDOW_MS,
  limit: LINK_MINT_PER_LEARNER_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: "RATE_LIMITED",
      domain: "client",
      message: "too many link codes requested",
      userMessage: "You have asked for several codes already. Use the last one, or try again in a few minutes.",
    },
  },
});
