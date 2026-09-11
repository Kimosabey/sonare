/**
 * Linking a second device: the two calls, and what happens to this device
 * afterwards.
 *
 * The server half is built (`server/linkCodes.ts`, and the two routes in
 * `server/routes/learners.ts`). This is the client half and it is deliberately
 * thin — the rules about codes live on the server, and a second set of them
 * here would be a second thing to keep in step.
 *
 * **Link, not transfer.** The learner id ends up shared between the devices
 * and the merge layer combines their records, so the first device is never
 * invalidated: "I bought a new phone" and "I also use a tablet" are the same
 * flow, and a learner who links a tablet and then picks their phone back up
 * finds everything still there.
 *
 * ── the credential, and how it is handled ───────────────────────────────────
 *
 * A link code grants full read, write and delete of a learner's record for the
 * ten minutes it lives. Everything unusual in this file follows from that:
 *
 * - It goes in a **request body**, never a URL. A query string is written to
 *   server access logs, browser history and any proxy in between, none of
 *   which forget in ten minutes.
 * - Nothing here logs. Not the code, not a prefix of it, not on the failure
 *   path — a log line is copied into tickets and shipped to aggregators, and
 *   `logger.error` on the server is careful about exactly this.
 * - Nothing here stores it. It lives in the caller's React state until the
 *   screen is done with it, which is why `mintCode` returns the expiry as well
 *   as the code: the screen that shows one needs to know when to stop.
 *
 * ── why the claim adopts, and in this order ─────────────────────────────────
 *
 * The claim returns `{ token, learnerId }`. Both are needed and neither is
 * enough: the token is the credential the sync layer presents, and the id is
 * what this device must now call itself — its own `ensureLearnerId` minted a
 * different one, and a device that kept it would sync to an empty record and
 * report success.
 *
 * The id is adopted **before** the token is saved. If the adoption is refused —
 * a body that is not an identity — nothing has been written, and a device left
 * holding a token for a learner it does not claim to be would present a
 * credential that disagrees with its own id on every later request.
 */

import { adoptLearnerId } from "../lib/learnerId.js";
import { normaliseLinkCode } from "../lib/linkCode.js";
import { saveToken } from "./tokenStore.js";

/** Injected in tests; defaults to the global. */
export interface LinkOptions {
  fetchImpl?: typeof fetch;
}

export interface MintedCode {
  /** Formatted for a person to read aloud — `ABCDE-FGHJK`. */
  code: string;
  /** When it stops being claimable, as milliseconds since the epoch. */
  expiresAt: number;
  expiresInSeconds: number;
}

export type MintResult = { ok: true; minted: MintedCode } | { ok: false; message: string };

/** Said when the server gave no wording of its own, and never a paraphrase of one. */
const MINT_FALLBACK = "Could not create a code just now. Please try again.";
const CLAIM_FALLBACK = "Could not link this device right now. Please try again.";
const OFFLINE = "Could not reach the server. Check your connection and try again.";

/**
 * The server's own wording where there is one.
 *
 * Deliberately not rewritten on the way through. The claim route distinguishes
 * "that is not a code" from "that code is not valid any more" and the second
 * one tells the learner what to do next — get a fresh one from the other
 * device — which a generic failure line would throw away.
 */
async function userMessageFrom(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { userMessage?: unknown } };
    const message = body.error?.userMessage;
    return typeof message === "string" && message.length > 0 ? message : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Asks this learner's server record for a code to show on the other device.
 *
 * Authenticated: only a learner may mint their own code, so this takes the
 * signed token rather than the bare id. Minting retires whatever unclaimed
 * code the learner had, so tapping the button twice replaces the code rather
 * than leaving two live and the learner guessing which one works.
 *
 * `expiresAt` is computed from `expiresInSeconds` against this device's clock
 * rather than read from the server's ISO timestamp, because the countdown it
 * drives is shown on this device. A phone whose clock is a day out would
 * otherwise render "expires in 23:59:41" over a code that dies in ten minutes —
 * the elapsed-time answer is right even when the wall clock is not.
 */
export async function mintCode(token: string, options: LinkOptions = {}): Promise<MintResult> {
  const doFetch = options.fetchImpl ?? fetch;

  try {
    const response = await doFetch("/api/v1/learners/me/link", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      return { ok: false, message: await userMessageFrom(response, MINT_FALLBACK) };
    }

    const body = (await response.json()) as { code?: unknown; expiresInSeconds?: unknown };
    // Checked rather than trusted: a code the server did not send is a code no
    // device can claim, and showing one would send a learner to type it.
    if (typeof body.code !== "string" || body.code.length === 0) {
      return { ok: false, message: MINT_FALLBACK };
    }

    const seconds =
      typeof body.expiresInSeconds === "number" && Number.isFinite(body.expiresInSeconds)
        ? Math.max(0, Math.floor(body.expiresInSeconds))
        : 0;

    return {
      ok: true,
      minted: { code: body.code, expiresInSeconds: seconds, expiresAt: Date.now() + seconds * 1000 },
    };
  } catch {
    // Offline, blocked, aborted. No code was created and nothing was changed.
    return { ok: false, message: OFFLINE };
  }
}

export type ClaimResult = { ok: true; learnerId: string } | { ok: false; message: string };

/**
 * Claims a code typed on this device, and becomes that learner here.
 *
 * Unauthenticated by necessity — this device has no credential yet, and if it
 * had one it would not need to link. The code is the credential for this one
 * request.
 *
 * Normalised here first so that a string the server could not accept under any
 * circumstances does not spend one of the ten attempts this address gets every
 * ten minutes. That check is the client copy of the server's rule and refuses
 * unknown characters rather than stripping them — see `normaliseLinkCode`.
 *
 * `learnerName` is which learner on *this* device is being linked. It is the
 * key everything local is filed under, so passing the wrong one would adopt an
 * id into somebody else's slot on a shared tablet; passing the current one is
 * what makes the two halves of a household stay two learners.
 */
export async function claimCode(
  code: string,
  learnerName: string | null,
  options: LinkOptions = {},
): Promise<ClaimResult> {
  const normalised = normaliseLinkCode(code);
  if (normalised === null) {
    // The server's own wording for the same refusal, so a learner does not get
    // two different sentences for one mistake depending on where it was caught.
    return { ok: false, message: "That does not look like a link code. Check it and try again." };
  }

  const doFetch = options.fetchImpl ?? fetch;

  try {
    const response = await doFetch("/api/v1/learners/link/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // In the body. Never a query string — see the file comment.
      body: JSON.stringify({ code: normalised }),
    });

    if (!response.ok) {
      return { ok: false, message: await userMessageFrom(response, CLAIM_FALLBACK) };
    }

    const body = (await response.json()) as { token?: unknown; learnerId?: unknown };
    if (
      typeof body.token !== "string" ||
      body.token.length === 0 ||
      typeof body.learnerId !== "string"
    ) {
      return { ok: false, message: CLAIM_FALLBACK };
    }

    // The identity first. A token saved beside an id this device refused would
    // be a credential disagreeing with the id every later request carries.
    if (!adoptLearnerId(learnerName, body.learnerId)) {
      return { ok: false, message: CLAIM_FALLBACK };
    }
    saveToken(learnerName, body.token);

    return { ok: true, learnerId: body.learnerId };
  } catch {
    return { ok: false, message: OFFLINE };
  }
}
