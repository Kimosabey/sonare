/**
 * A durable, anonymous id for the learner on this device.
 *
 * The keystone the server-side work needs. Today `learnerName` — free text
 * typed into the language picker — is the only identity there is, so two
 * learners called "marie" on two devices are one string and one learner who
 * retypes their name as "Marie" becomes a different person. Nothing
 * server-side can be safely attributed to anyone.
 *
 * Deliberately **not** authentication. No password, no email, no login screen:
 * the PRD's "no new authentication" holds. This identifies a device-profile,
 * carries no personal data, and is minted here rather than issued by the
 * server so that a learner who has never been online still has one.
 *
 * It is also not a credential on its own. Anyone can claim any id by sending
 * it, so the server signs it and the signed token is what authorises a
 * request — see the identity middleware. This module only answers "who is
 * this browser saying it is".
 *
 * Keyed by the learner's chosen name as well as by device, and that is a bug
 * fix rather than a nicety. It used to be one id per browser while every local
 * store keyed on the name — so on a shared device two learners had separate
 * local progress and were pushed to the server under the *same* identity. The
 * server merged them: shared streak days, pooled sound histories across two
 * different accents, and activities showing as passed that the other person
 * had never attempted. A classroom tablet is the stated commercial surface, so
 * this was exactly the wrong thing to get wrong.
 *
 * One honest limit remains. Clearing site data loses the id, and with it the
 * link to the server's copy of that learner's progress. That is inherent to
 * anonymity, and is only fixed by an optional account — which must never
 * become required in order to practise.
 */

import { newUuid } from "./uuid.js";

/** In the key, so a bump orphans the old id rather than misreading it. */
const SCHEMA_VERSION = "v1";

/**
 * `anonymous` for a learner who has not given a name, matching the fallback
 * every other store uses so the two never disagree about who is who.
 */
function storageKey(learnerName: string | null): string {
  return `sonare.learnerId.${SCHEMA_VERSION}.${learnerName ?? "anonymous"}`;
}

/**
 * Set when storage could not be written, so one session keeps a stable id even
 * where nothing can be persisted.
 *
 * Without this, private browsing or a full quota would mint a fresh id on
 * every call — and since this id is about to key progress, skills and streaks,
 * that would silently split one session's work across several learners.
 */
const inMemory = new Map<string, string>();

/** RFC 4122 shape. A stored value that is not one is not an identity. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The stored id, or null.
 *
 * Validated rather than trusted. This value outlives the code that wrote it
 * and is trivially editable, and an id of `""` or `"null"` would key a shared
 * bucket that every learner on the device would land in.
 */
export function readLearnerId(learnerName: string | null): string | null {
  const key = storageKey(learnerName);
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null && UUID.test(raw)) return raw;
  } catch {
    // Storage disabled or blocked. Fall through to whatever this session has.
  }
  return inMemory.get(key) ?? null;
}

/**
 * The learner's id, minting and persisting one on first call.
 *
 * Never throws and never returns null: a caller that cannot get an id has no
 * sensible fallback, and every screen that needs one needs it to render.
 */
export function ensureLearnerId(learnerName: string | null): string {
  const existing = readLearnerId(learnerName);
  if (existing !== null) return existing;

  const key = storageKey(learnerName);
  const minted = newUuid();
  inMemory.set(key, minted);

  try {
    localStorage.setItem(key, minted);
  } catch {
    // Quota, or private browsing. The id holds for this session in memory;
    // only its durability is lost, which is the right thing to sacrifice.
  }

  return minted;
}

/**
 * Forgets the id, for a "start over" or a deletion request.
 *
 * Clears the in-memory copy too. Leaving it would make a reset look like it
 * worked and then hand back the same identity for the rest of the session.
 */
export function clearLearnerId(learnerName: string | null): void {
  const key = storageKey(learnerName);
  inMemory.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {
    // Best effort.
  }
}
