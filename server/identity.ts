/**
 * Signed, anonymous learner tokens.
 *
 * The client mints its own learner id (src/lib/learnerId.ts) so that a learner
 * who has never been online still has one. That id is **not** a credential:
 * anyone can send any id, so on its own it would let a caller read or overwrite
 * another learner's progress just by guessing — an enumeration and tampering
 * hole that would be load-bearing by the time a leaderboard or a class view
 * existed.
 *
 * So the server signs the id it was given and hands back a token. The token is
 * what authorises a request; the bare id authorises nothing.
 *
 * Deliberately an HMAC rather than a JWT. There are no claims to carry beyond
 * the id and the issue time, no third party to verify it, and no key rotation
 * story that a library would help with — so a JWT would add a dependency, an
 * algorithm-confusion class of bug, and a parser, in exchange for nothing.
 * `node:crypto` is already there.
 *
 * Still not authentication. No password, no email, no login screen: the PRD's
 * "no new authentication" holds. This proves only that *this browser* is the
 * one the server issued a token to. Losing the token loses the account, which
 * is inherent to anonymity and is only fixed by an optional account upgrade
 * that must never become required in order to practise.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "./errors.js";
import { logger } from "./logger.js";

/**
 * No default, ever.
 *
 * A built-in fallback secret is not a weaker version of this — it is none of
 * it, because the value would be in the repository and anyone could forge any
 * learner. DIAGNOSTICS_TOKEN already establishes the rule here: there is no
 * "unset means open".
 */
const SECRET = process.env.LEARNER_TOKEN_SECRET ?? "";

/** RFC 4122 v4, matching what the client mints. */
const LEARNER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * How long a token stays valid.
 *
 * Long, because expiry here is a bound on a leaked token's usefulness rather
 * than a session timeout — there is no password to re-enter, so an expiry a
 * learner notices is an expiry that loses their progress. Rotation on use
 * (see the route) is what keeps the window short in practice.
 */
const MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;

export function identityConfigured(): boolean {
  return SECRET.length > 0;
}

/** Thrown rather than returned, because every caller must stop. */
function notConfigured(): AppError {
  return new AppError({
    code: "MISCONFIGURED",
    domain: "server",
    message: "LEARNER_TOKEN_SECRET is not set — identity is disabled",
    userMessage: "Sign-in is not available right now.",
    status: 503,
  });
}

export function isLearnerId(value: unknown): value is string {
  return typeof value === "string" && LEARNER_ID.test(value);
}

function sign(payload: string): string {
  return createHmac("sha256", SECRET).update(payload).digest("base64url");
}

/**
 * Issues a token for an id the client minted.
 *
 * The id is validated first. Signing an arbitrary string would make the token
 * a carrier for whatever the caller sent — a path fragment, a Mongo operator,
 * a hundred kilobytes — and every later layer would be trusting it because it
 * came back signed.
 */
export function issueToken(learnerId: string, now: number = Date.now()): string {
  if (!identityConfigured()) throw notConfigured();
  if (!isLearnerId(learnerId)) {
    throw new AppError({
      code: "INVALID_REQUEST",
      domain: "client",
      message: `not a learner id: ${JSON.stringify(learnerId).slice(0, 80)}`,
      userMessage: "That identifier is not valid.",
    });
  }

  const payload = `${learnerId}.${now}`;
  return `${payload}.${sign(payload)}`;
}

/**
 * A keyed digest of a value, so a credential can be recognised without being
 * stored.
 *
 * Written for the device-link codes (linkCodes.ts), which have to be checked
 * against something the database holds while the database itself holds
 * nothing that hands out an identity.
 *
 * **Keyed**, not a bare SHA-256, and that is the substance rather than a
 * flourish. A link code is short and human-typeable — a few hundred trillion
 * possibilities — which is ample against an online guess bounded by a rate
 * limit and nowhere near enough against an offline one: a stolen table of
 * plain digests over that keyspace is enumerable on commodity hardware in
 * hours. Under an HMAC the attacker needs this secret as well, and with this
 * secret they could forge a token for any learner directly and would have no
 * use for the codes at all.
 *
 * `domain` separates one use of this from the next, with a separator between,
 * so that ("a", "bc") and ("ab", "c") cannot produce the same digest. Every
 * domain here is a fixed literal containing no `|`, which is what makes the
 * separation unambiguous rather than merely likely.
 *
 * Lives here rather than in the caller so that exactly one module reads
 * LEARNER_TOKEN_SECRET. A second reader would be a second place for "unset
 * means disabled" to be got wrong, and getting it wrong there means a digest
 * keyed on the empty string — a bare hash wearing an HMAC's name.
 */
export function keyedDigest(domain: string, value: string): string {
  if (!identityConfigured()) throw notConfigured();
  return createHmac("sha256", SECRET).update(`${domain}|${value}`).digest("base64url");
}

export type Verification =
  | { ok: true; learnerId: string; issuedAt: number }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" };

/**
 * Verifies a token and returns the id it carries.
 *
 * Every rejection path is a plain result rather than a throw, so a caller
 * cannot accidentally treat "could not check" as "checked and fine".
 *
 * The comparison is `timingSafeEqual`. A `===` on two HMACs leaks how many
 * leading bytes matched through the time it takes to fail, which is enough to
 * recover a valid signature byte by byte. Lengths are compared first because
 * timingSafeEqual throws on a mismatch — and a length difference is not itself
 * secret, since the digest length is fixed and public.
 */
export function verifyToken(token: unknown, now: number = Date.now()): Verification {
  if (!identityConfigured()) throw notConfigured();
  if (typeof token !== "string") return { ok: false, reason: "malformed" };

  // Exactly three parts. Splitting and taking the last would let a caller
  // smuggle extra dots into the payload and still match a signature.
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };

  const [learnerId, issuedAtRaw, provided] = parts;
  if (learnerId === undefined || issuedAtRaw === undefined || provided === undefined) {
    return { ok: false, reason: "malformed" };
  }
  if (!isLearnerId(learnerId)) return { ok: false, reason: "malformed" };

  // Integer, and only digits — `Number("1e999")` is Infinity and `Number(" 1")`
  // is 1, either of which would make the age check meaningless.
  if (!/^\d{1,15}$/.test(issuedAtRaw)) return { ok: false, reason: "malformed" };
  const issuedAt = Number(issuedAtRaw);

  const expected = Buffer.from(sign(`${learnerId}.${issuedAtRaw}`), "utf8");
  const actual = Buffer.from(provided, "utf8");
  if (expected.length !== actual.length) return { ok: false, reason: "bad-signature" };
  if (!timingSafeEqual(expected, actual)) return { ok: false, reason: "bad-signature" };

  // Checked after the signature, so an unsigned token never reaches a branch
  // that could report anything about it.
  if (now - issuedAt > MAX_AGE_MS) return { ok: false, reason: "expired" };
  // A token from the future is not a clock to trust. Allow a minute of skew
  // between instances and reject beyond it.
  if (issuedAt - now > 60_000) return { ok: false, reason: "malformed" };

  return { ok: true, learnerId, issuedAt };
}

/** The `Authorization: Bearer <token>` value, or null. */
export function bearerFrom(header: unknown): string | null {
  if (typeof header !== "string") return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match?.[1] ?? null;
}

export function warnIfIdentityDisabled(): void {
  if (!identityConfigured()) {
    logger.warn("LEARNER_TOKEN_SECRET is not set — learner identity and sync are disabled");
  }
}
