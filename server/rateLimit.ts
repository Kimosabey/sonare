/**
 * Rate limits — this endpoint is an open proxy to a metered Azure API with
 * no auth in front of it (PRD.md: "no new authentication — the app has it,"
 * true for the learner flow this ships inside, not for a standalone
 * exposure like the ngrok-tunneled dev server this session used). Without a
 * cap, anyone who finds the URL can run up the Azure bill.
 */

import rateLimit from "express-rate-limit";

/** Generous for real use — 3 scored tries × 10 activities is 30 calls in a
    session, spread over minutes, not seconds. Tight enough to block a script. */
export const scoringLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", domain: "client", message: "too many scoring requests", userMessage: "Please slow down and try again in a moment." } },
});

/** Diagnostics reads/writes are cheap (no external API cost) — this is
    about abuse volume, not billing, so the ceiling is looser. */
export const diagnosticsLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
