/**
 * Linking a second device to an existing learner, with a short-lived code.
 *
 * The hole this fills: `src/lib/learnerId.ts` mints a fresh id per browser and
 * there was no transfer, pairing or recovery path anywhere. A learner who
 * changed phone lost every record they had, silently, with no warning and no
 * way back — and "I bought a new phone" was indistinguishable from "I also use
 * a tablet", because neither was possible.
 *
 * **Link, not transfer.** The learner id stays shared between the devices and
 * the existing merge layer combines their records, which is what that layer
 * was built for and proved commutative and idempotent. So the first device is
 * deliberately *not* invalidated: after a link, both work, and the two stories
 * above become one flow.
 *
 * ── how this relates to the learner id itself ────────────────────────────────
 *
 * A security audit already noted that the learner id functions as a bearer
 * credential in its own right: `POST /learners` signs any well-formed id it is
 * handed, so anyone who learns an id can have it signed and then read, write
 * and delete that learner's record, for four hundred days.
 *
 * A link code is the same power, deliberately scoped down on every axis that
 * one is not: it lives for minutes rather than forever, it is consumed by the
 * first claim rather than replayable, it is stored only as a keyed digest
 * rather than being a value the client already knows, and it is rate limited
 * as a credential path. So it is strictly better than the hole beside it — and
 * that is the point of the comparison. **Do not read it as licence to treat
 * the two as equivalent**: widening a link code's expiry or dropping its
 * single-use rule turns it into the bare id again, which is the thing the
 * audit flagged rather than a precedent for it.
 *
 * ── why a short typeable code rather than a UUID ─────────────────────────────
 *
 * Because a person reads it off one screen and types it into another. A UUID
 * cannot be read aloud, cannot be typed without a mistake, and cannot fit on a
 * phone screen at a legible size. The whole design — the alphabet, the length,
 * the grouping, the expiry and both rate limits — follows from that one
 * requirement, and the arithmetic that says the choice is safe is in
 * `CODE_ALPHABET` and `LINK_CODE_TTL_SECONDS` below.
 */

import { randomInt, timingSafeEqual } from "node:crypto";
import { getDb } from "./db.js";
import { logger } from "./logger.js";
import { numberFromEnv } from "./env.js";
import { keyedDigest } from "./identity.js";

/**
 * The code alphabet: thirty characters, chosen so no character can be misread
 * as another character in the same alphabet.
 *
 * `0`/`O`, `1`/`I`/`L` and `U`/`V` are the pairs people actually confuse when
 * copying a code off a second screen, so **both** halves of each are gone
 * rather than one — folding `O` to `0` on input only helps if one of them is
 * valid, and keeping neither means a misread is a wrong character rather than
 * a wrong learner. What is left is 2-9 and A-Z without I, L, O or U.
 *
 * Case is folded and separators are stripped on the way in (`normaliseCode`),
 * so the realistic failure is a genuinely wrong character, which costs the
 * caller one of their ten attempts and reveals nothing.
 */
export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Ten characters, shown as two groups of five.
 *
 * The keyspace is 30^10 = 590,490,000,000,000 — about 5.9 × 10^14, or 2^49.1.
 *
 * The arithmetic that number has to survive, with the rate limits in
 * rateLimit.ts and the ten-minute life below:
 *
 *   - Per address: 10 claim attempts per 10 minutes. Fixed windows, so the
 *     worst case across a boundary is 20 in quick succession.
 *   - Globally: 600 *failed* claim attempts per minute, across every caller,
 *     so about 6,600 guesses can be spent against the entire service during
 *     any one code's ten-minute life.
 *   - Live codes: minting retires the learner's previous unclaimed code, so a
 *     learner has at most one live code and the attacker's target set is the
 *     number of learners mid-link rather than the number of learners.
 *
 * So the chance of guessing a particular live code before it expires is about
 * 6,600 / 5.9e14 ≈ 1.1 × 10^-11, and with a thousand codes live at once —
 * a thousand people linking a device in the same ten minutes — the chance of
 * hitting *any* of them is still about 1.1 × 10^-8 per window. Sustained for a
 * year without pause that is roughly 6 × 10^-4.
 *
 * Eight characters would have been friendlier to type and would have left
 * 30^8 ≈ 6.6 × 10^11, where the same year of attack comes out near 10^-1 —
 * which is why this is ten and not eight. Widening the code is free; widening
 * the rate limit is not.
 */
export const CODE_LENGTH = 10;

/** Two groups of five, hyphenated, because nobody reads ten characters back. */
const GROUP_SIZE = 5;

/**
 * How long a code can be claimed for. Minutes, not hours.
 *
 * Ten is long enough to walk to the other device, unlock it, find the screen
 * and type the code with a mistake in the middle; short enough that a code
 * left on a shared screen or shouted across a room is dead before anybody
 * could act on it, and short enough that the brute-force budget above is a
 * ten-minute budget rather than an afternoon's.
 *
 * Configurable, and bounded on both sides. Thirty seconds is the floor because
 * anything shorter cannot be typed; an hour is the ceiling because a code that
 * outlives the conversation that produced it is a credential lying around.
 */
export const LINK_CODE_TTL_SECONDS = numberFromEnv("LINK_CODE_TTL_SECONDS", 600, {
  integer: true,
  min: 30,
  max: 3600,
});

/**
 * Separates this digest from any other use of the signing secret.
 *
 * Without it a link-code digest and some future digest of the same string
 * would be the same bytes, and a value accepted in one place would be
 * accepted in the other.
 */
const DIGEST_DOMAIN = "device-link";

/** Longer than any code plus its separators, so a megabyte is refused early. */
const MAX_SUBMITTED_LENGTH = 64;

/**
 * A stored code.
 *
 * `_id` is the **keyed digest** and never the code — that is the point of the
 * collection's shape. A leaked database therefore hands out no identities: to
 * turn a row back into a code an attacker needs LEARNER_TOKEN_SECRET, and with
 * that they could forge tokens directly and would not want the codes.
 *
 * Keeping the digest in `_id` rather than in a field is what makes the claim a
 * single conditional update on a unique key — see `claimLinkCode`.
 *
 * `claimedAt` records the consumption rather than deleting the row, so a
 * second attempt is refused by the same filter that let the first through, and
 * so a reuse attempt is visible in the data until the TTL sweeps it.
 */
export interface LinkCodeDocument {
  /** Keyed digest of the normalised code. Never the code. */
  _id: string;
  learnerId: string;
  createdAt: Date;
  /** The TTL index in db.ts expires the row at this instant. */
  expiresAt: Date;
  /** Null until the one claim that consumes it. */
  claimedAt: Date | null;
}

export interface MintedLinkCode {
  /** Formatted for a human to read aloud or type. Never logged, never stored. */
  code: string;
  expiresAt: Date;
  expiresInSeconds: number;
}

/**
 * What a learner may see about their own codes in a data export.
 *
 * Deliberately without the digest. It is their own row, but an export is a
 * file that gets mailed to itself and uploaded to things, and the digest plus
 * this server's secret is the code — so the export answers "you have an
 * unclaimed link code, made then, dying then" and stops there. That is the
 * part a person could act on anyway.
 */
export interface LinkCodeSummary {
  createdAt: Date;
  expiresAt: Date;
  claimedAt: Date | null;
}

/**
 * A fresh code, uniformly distributed over the alphabet.
 *
 * `randomInt` rather than `Math.random()` or a byte modulo the alphabet size.
 * `Math.random()` is not a CSPRNG, and `bytes[i] % 30` is biased — 256 is not
 * a multiple of 30, so six of the thirty characters would come up 5/6 as often
 * as the rest and the real keyspace would be smaller than the arithmetic
 * above claims. `randomInt` rejection-samples, so there is no bias to reason
 * about.
 */
function generateCode(): string {
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += CODE_ALPHABET.charAt(randomInt(CODE_ALPHABET.length));
  }
  return code;
}

/** `ABCDE-FGHJK` — grouped for reading, stripped again on the way back in. */
export function formatCode(code: string): string {
  const groups: string[] = [];
  for (let at = 0; at < code.length; at += GROUP_SIZE) groups.push(code.slice(at, at + GROUP_SIZE));
  return groups.join("-");
}

/**
 * The code as it will be hashed, or null if it cannot be one.
 *
 * Forgiving about presentation and strict about content. Whitespace and
 * hyphens go, because a learner types the code the way it was shown and a
 * client may or may not strip the grouping; case is folded, because phone
 * keyboards capitalise. Everything else must already be in the alphabet:
 * stripping *unknown* characters instead would mean `A!B!C!...` normalised to
 * a valid code, which quietly widens what counts as a match.
 *
 * Length is checked before anything else so an enormous body is refused
 * without hashing it.
 */
export function normaliseCode(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_SUBMITTED_LENGTH) return null;

  const stripped = value.replace(/[\s-]+/g, "").toUpperCase();
  if (stripped.length !== CODE_LENGTH) return null;
  for (const character of stripped) {
    if (!CODE_ALPHABET.includes(character)) return null;
  }
  return stripped;
}

/** The stored form of a code. Exported for the tests, which must not guess it. */
export function digestOf(code: string): string {
  return keyedDigest(DIGEST_DOMAIN, code);
}

/**
 * Mints a code for a learner and stores only its digest.
 *
 * The previous unclaimed code is retired first, so a learner has at most one
 * live code at a time. Two reasons, and the second is the load-bearing one:
 * a learner who taps the button twice should not be left guessing which of two
 * codes is the real one, and — the arithmetic — an attacker's chance of
 * hitting *some* live code scales with how many are live, so letting a learner
 * accumulate them would multiply the only number in this file's budget that an
 * attacker gets for free.
 *
 * Throws rather than returning a failure. A mint that could not be stored must
 * not hand back a code the claim will refuse: the learner would type a code
 * that cannot work and conclude the feature is broken, which is worse than
 * being told to try again.
 */
export async function mintLinkCode(learnerId: string, now: Date = new Date()): Promise<MintedLinkCode> {
  // Before the database work, so an unconfigured server refuses rather than
  // storing a digest keyed on the empty string.
  const code = generateCode();
  const id = digestOf(code);

  const expiresAt = new Date(now.getTime() + LINK_CODE_TTL_SECONDS * 1000);
  const db = await getDb();
  const codes = db.collection<LinkCodeDocument>("linkcodes");

  await codes.deleteMany({ learnerId });
  await codes.insertOne({ _id: id, learnerId, createdAt: now, expiresAt, claimedAt: null });

  return { code: formatCode(code), expiresAt, expiresInSeconds: LINK_CODE_TTL_SECONDS };
}

/**
 * The outcome of a claim.
 *
 * `not-claimable` is one case on purpose and covers unknown, expired and
 * already-claimed alike. Three reasons would tell a caller which half of a
 * guess was right — that a code exists but has expired is a fact about
 * somebody else's account — and the client does the same thing in all three:
 * ask the other device for a new code. `middleware/identity.ts` makes the same
 * choice about "expired" versus "bad signature", for the same reason.
 */
export type ClaimOutcome =
  | { ok: true; learnerId: string }
  | { ok: false; reason: "malformed" | "not-claimable" | "unavailable" };

/**
 * Consumes a code, atomically, and says whose learner it was.
 *
 * **One conditional update decides the winner.** The filter carries the whole
 * claimability test — the right digest, not yet claimed, not yet expired — and
 * the update stamps `claimedAt`, so Mongo matches exactly one of any number of
 * concurrent claims and the losers see `matchedCount: 0`. This is the shape
 * `reserveScoringCall` uses in counters.ts and it is here for the same reason:
 * a read-then-write has a window in which two devices both read "unclaimed"
 * and both proceed, which for a credential means two devices both adopting one
 * learner from one code that was only ever meant to link one.
 *
 * The `findOne` afterwards is not part of that decision. The winner has
 * already been chosen by the update above; this only reads back the immutable
 * `learnerId` from the row that was consumed, and it runs only on the path
 * that already succeeded.
 *
 * Failure is a result rather than a throw, so a caller cannot mistake "could
 * not check" for "checked and fine" — the same rule `verifyToken` follows.
 */
export async function claimLinkCode(value: unknown, now: Date = new Date()): Promise<ClaimOutcome> {
  const code = normaliseCode(value);
  if (code === null) return { ok: false, reason: "malformed" };

  const id = digestOf(code);

  try {
    const db = await getDb();
    const codes = db.collection<LinkCodeDocument>("linkcodes");

    const consumed = await codes.updateOne(
      { _id: id, claimedAt: null, expiresAt: { $gt: now } },
      { $set: { claimedAt: now } },
    );
    if (consumed.matchedCount !== 1) return { ok: false, reason: "not-claimable" };

    const document = await codes.findOne({ _id: id });
    if (document === null) return { ok: false, reason: "not-claimable" };

    /**
     * The post-condition, in constant time.
     *
     * Given the filter above this is a tautology today, and that is exactly
     * what makes it worth asserting: the thing standing between "this code
     * matches" and "some code matched" is one filter, and a later edit that
     * widened it — a lookup by learner, a fallback when the digest is missing
     * — would be invisible to every other test. `timingSafeEqual` rather than
     * `===` so the check cannot itself become the leak, following the same
     * rule identity.ts's signature comparison follows; lengths first, because
     * timingSafeEqual throws on a mismatch and a digest's length is public.
     */
    const expected = Buffer.from(id, "utf8");
    const actual = Buffer.from(document._id, "utf8");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      // No code, no digest and no learner in the line: this is the one place
      // that knows both, and a log is the wrong place for either.
      logger.error("[link] consumed a code whose digest is not the one presented — refusing");
      return { ok: false, reason: "not-claimable" };
    }

    return { ok: true, learnerId: document.learnerId };
  } catch (err) {
    // Never the code, and never the digest — a digest plus this server's
    // secret is the code, and logs travel further than databases do.
    logger.error({ err }, "[link] could not claim a device link code");
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * A learner's own link codes, for an export — digests withheld.
 *
 * Throws rather than swallowing, matching `listAttemptsFor`. The export route
 * fails the whole request rather than returning a partial record, because the
 * document a learner would check a deletion against must not be quietly short
 * of a collection.
 */
export async function listLinkCodesFor(learnerId: string): Promise<LinkCodeSummary[]> {
  const db = await getDb();
  const documents = await db.collection<LinkCodeDocument>("linkcodes").find({ learnerId }).toArray();
  return documents.map((document) => ({
    createdAt: document.createdAt,
    expiresAt: document.expiresAt,
    claimedAt: document.claimedAt,
  }));
}

/**
 * Erases a learner's link codes. Part of a deletion request.
 *
 * Throws on failure, unlike `deleteRateLimitsFor` next to it, and the
 * difference is deliberate. A rate-limit window left behind is a stale abuse
 * counter that expires on its own within minutes; a link code left behind is a
 * live credential for an account that has just been erased, and somebody
 * holding it could re-establish an identity the learner asked us to destroy.
 * So this one is allowed to fail the deletion and make the learner retry.
 *
 * A query on `learnerId` with no index behind it, which is fine for the same
 * reason it is fine in the rate-limit store: a data request is rare, and this
 * collection is swept continuously by a ten-minute TTL, so it is never large.
 */
export async function deleteLinkCodesFor(learnerId: string): Promise<number> {
  const db = await getDb();
  const result = await db.collection<LinkCodeDocument>("linkcodes").deleteMany({ learnerId });
  return result.deletedCount;
}
