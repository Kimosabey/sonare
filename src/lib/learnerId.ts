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
 *
 * What `adoptLearnerId` adds is the *second* device rather than an account.
 * Minting was the only way in here until now, so a learner who changed phone
 * silently started again; the server can hand a device an id it already knows
 * (server/linkCodes.ts), and this is where that id is taken up. It is a link
 * and not a transfer — both devices keep the same id afterwards and the merge
 * layer combines their records — so nothing here invalidates anything.
 */

import { newUuid } from "./uuid.js";

/** In the key, so a bump orphans the old id rather than misreading it. */
const SCHEMA_VERSION = "v1";

/**
 * Named, because two things now have to agree about it: the key builder below
 * and `knownLearners`, which reads the names back out of it. A prefix written
 * twice is a prefix that drifts once.
 */
const KEY_PREFIX = `sonare.learnerId.${SCHEMA_VERSION}.`;

/**
 * `anonymous` for a learner who has not given a name, matching the fallback
 * every other store uses so the two never disagree about who is who.
 */
const ANONYMOUS = "anonymous";

function storageKey(learnerName: string | null): string {
  return `${KEY_PREFIX}${learnerName ?? ANONYMOUS}`;
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
 * Takes up an id this device was handed, instead of the one it minted.
 *
 * The other half of device linking. `claimLinkCode` on the server returns the
 * learner id alongside the token precisely so the client does not have to
 * parse a token to find it, and this is the only thing that may act on that
 * answer — every other function here mints or reads.
 *
 * **Written under this learner's key and nowhere else.** The store is keyed
 * per learner name (see the file comment) because two learners on one device
 * used to collide into a single server identity and pool their records, sound
 * histories across two accents included. Adopting is the one operation that
 * could undo that keying by accident — writing a claimed id to every key, or
 * to a bare device-wide key, would re-create exactly that bug and would be
 * silent — so it goes through `storageKey` like everything else and touches
 * precisely one entry.
 *
 * Validated with the same shape `readLearnerId` demands, and refused rather
 * than coerced. The value crossed a network; storing a non-identity would key
 * this learner's progress on a shared bucket, and returning false lets the
 * caller say the link did not work instead of pretending it did. The shape is
 * checked and not the UUID *version*: the id belongs to the server's record,
 * and a client is in no position to rule on how it was generated.
 *
 * Not a merge. Local progress, skills and streaks are keyed on the name and
 * are untouched here; the server's merge layer is what combines the two
 * devices' records on the next sync.
 */
export function adoptLearnerId(learnerName: string | null, learnerId: string): boolean {
  if (!UUID.test(learnerId)) return false;

  const key = storageKey(learnerName);
  inMemory.set(key, learnerId);

  try {
    localStorage.setItem(key, learnerId);
  } catch {
    // Quota, or private browsing. The adoption holds for this session, which
    // is what lets the sync that follows it reach the right record.
  }

  return true;
}

/**
 * The named learners this device has an id for, so switching is a choice from
 * a list rather than a retype.
 *
 * The family tablet is the case: one household, two people, one browser.
 * Retyping is not a neutral alternative to picking — every store here keys on
 * the name, so "Maya " or "maya" is a *different learner* with no progress and
 * no streak, and nothing on screen would say so. The list removes the only
 * step at which that mistake is possible.
 *
 * Reading the keys directly is confined to this module deliberately. It is the
 * module that defines the key shape, so the prefix cannot drift out of step
 * with `storageKey`; a screen doing its own prefix scan is one filtering
 * mistake away from reading a key that is not an identity at all.
 *
 * Sorted, so the list does not reshuffle when storage returns keys in a
 * different order. The unnamed bucket is left out because it has no name to
 * show — a caller offering "carry on without a name" says so in its own words.
 */
export function knownLearners(): string[] {
  const names = new Set<string>();

  const collect = (key: string): void => {
    if (!key.startsWith(KEY_PREFIX)) return;
    const name = key.slice(KEY_PREFIX.length);
    if (name === "" || name === ANONYMOUS) return;
    names.add(name);
  };

  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key !== null) collect(key);
    }
  } catch {
    // Storage disabled or blocked. Whatever this session minted still counts.
  }
  for (const key of inMemory.keys()) collect(key);

  return [...names].sort((a, b) => a.localeCompare(b));
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
