/**
 * Reading and typing a device link code, on the client side of it.
 *
 * The server owns the codes — `server/linkCodes.ts` mints them, digests them
 * and decides what is claimable — and this file owns nothing except the two
 * string operations that happen on a phone: showing a code in a shape a person
 * can read aloud, and turning what they typed on the other device back into
 * the exact characters the server hashed.
 *
 * ── why the client normalises at all ────────────────────────────────────────
 *
 * The server normalises too, and its answer is the one that counts. This is
 * here so that a code the server could not possibly accept never leaves the
 * device: a typo costs one of ten attempts per ten minutes against a shared
 * global budget of six hundred failures a minute, and spending that budget on
 * a string that is nine characters long tells the learner nothing and makes
 * the real attempt more likely to be rate-limited. It also lets the field say
 * "that is not a code" immediately, without a round trip.
 *
 * ── the one rule that is easy to get backwards ──────────────────────────────
 *
 * **Separators are stripped; unknown characters are refused.** Whitespace and
 * hyphens go, because the code is shown grouped and a learner types it the way
 * they saw it, and case is folded, because phone keyboards capitalise. Every
 * remaining character must already be in the alphabet.
 *
 * Stripping *unknown* characters instead — a `replace(/[^A-Z0-9]/g, "")`, which
 * is the obvious one-liner — would mean `A!B!C!D!E!F!G!H!J!K!` normalises to a
 * valid code. That quietly widens what counts as a match: two different typed
 * strings become the same credential, and a field that accepts punctuation as
 * filler accepts a paste from anywhere. The server refuses that for the same
 * reason, in the same words; this is the client saying the same thing rather
 * than a looser version of it.
 *
 * ── what this file must never do ────────────────────────────────────────────
 *
 * A code grants full read, write and delete of a learner's record for the ten
 * minutes it lives. So it is never logged, never put in a URL or a query
 * string, and never stored. It travels in a request body and lives in React
 * state until the screen is done with it.
 */

/**
 * Thirty characters, and it must equal `CODE_ALPHABET` in server/linkCodes.ts.
 *
 * Copied rather than imported because `src/` cannot reach `server/` — the
 * client tsconfig includes `src` only, and a client bundle that imported a
 * server module would pull `node:crypto` into a browser. The copy is checked
 * against the original by `scripts/link-code.contract.test.ts`, which reads
 * both files, so a drift fails a gate rather than quietly rejecting every
 * valid code on every device.
 *
 * Both halves of `0`/`O`, `1`/`I`/`L` and `U`/`V` are absent, which is why
 * folding `O` to `0` on input would be wrong here: neither is valid, so a
 * misread is a wrong character rather than a wrong learner.
 */
export const LINK_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Ten characters. Must equal `CODE_LENGTH` in server/linkCodes.ts. */
export const LINK_CODE_LENGTH = 10;

/** Two groups of five, because nobody reads ten characters back. */
const GROUP_SIZE = 5;

/**
 * Longer than any code plus its separators, so a pasted page is refused before
 * it is scanned rather than after.
 */
const MAX_SUBMITTED_LENGTH = 64;

/**
 * What the learner typed, as the server will hash it — or null if it cannot be
 * a code at all.
 *
 * Null covers every refusal with one value on purpose: too long, too short,
 * and a character the alphabet does not contain are all "that is not a code",
 * and a caller that could tell them apart would only be able to say the same
 * sentence three ways.
 */
export function normaliseLinkCode(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_SUBMITTED_LENGTH) return null;

  // Separators only. Anything else surviving to the loop below is a refusal.
  const stripped = value.replace(/[\s-]+/g, "").toUpperCase();
  if (stripped.length !== LINK_CODE_LENGTH) return null;
  for (const character of stripped) {
    if (!LINK_CODE_ALPHABET.includes(character)) return null;
  }
  return stripped;
}

/**
 * `ABCDE-FGHJK`, for the screen that shows one.
 *
 * The server already sends the code formatted, so this exists for the case
 * where that changes and for the tests — and it is deliberately the inverse of
 * the strip above, so a code shown by this function is one `normaliseLinkCode`
 * accepts. Anything that is not a normalised code is returned untouched rather
 * than re-grouped: inventing a grouping for a string we do not recognise would
 * put a code-shaped thing on screen that no device can claim.
 */
export function formatLinkCode(code: string): string {
  // The normalised form, so a code that already carries its grouping is not
  // regrouped around its own hyphen into `ABCDE-FGHJ-K`.
  const normalised = normaliseLinkCode(code);
  if (normalised === null) return code;

  const groups: string[] = [];
  for (let at = 0; at < normalised.length; at += GROUP_SIZE) {
    groups.push(normalised.slice(at, at + GROUP_SIZE));
  }
  return groups.join("-");
}
