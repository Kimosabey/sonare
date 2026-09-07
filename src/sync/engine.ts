/**
 * Offline-first sync. The learner never waits for it and never sees it fail.
 *
 * The contract, in order of importance:
 *
 * **The local write has already happened.** Every caller reaches this after the
 * stores were updated and the UI rendered, so nothing here is on the critical
 * path of finishing an activity. A learner with no network completes a session
 * exactly as before.
 *
 * **A failure is silent and costs nothing.** The dirty flags survive in
 * storage, so the work is pushed on the next attempt — tomorrow, on another
 * device, whenever. No error is surfaced, because there is nothing for the
 * learner to do about it and telling them their progress failed to save would
 * be false: it is saved, locally.
 *
 * **Nothing local is lost to a merge.** The server's reply is the union of
 * every device's record including this one's, and it is folded back rather
 * than written over — attempts in particular are kept, because the server has
 * no copy of them (wire.ts).
 *
 * Lives outside `src/speech/` deliberately (R11): the capture layer's state is
 * in-memory only, and this is persistent by definition.
 */

import { readDirty, clearDirty, hasAnything, type DirtyState } from "./dirty.js";
import { ensureToken, clearToken } from "./tokenStore.js";
import {
  progressToWire,
  progressFromWire,
  skillsToWire,
  skillsFromWire,
  streakToWire,
  readSnapshot,
  type SyncSnapshot,
  type WireProgress,
  type WireSkills,
} from "./wire.js";
import { readProgress, writeProgress } from "../hooks/useProgressPersistence.js";
import { readSkills, writeSkills } from "../stores/skillStore.js";
import { readStreak, writeStreak } from "../stores/streakStore.js";

export type SyncOutcome =
  /** Pushed and/or pulled, and the local stores now hold the merged record. */
  | { status: "synced"; pushed: DirtyState }
  /** Nothing to push and nothing came back that differed. */
  | { status: "nothing-to-do" }
  /** Could not reach the server, or it refused. Dirty flags are untouched. */
  | { status: "deferred"; reason: "no-token" | "network" | "rejected" | "bad-response" };

export interface SyncOptions {
  learnerName: string | null;
  /** Sent on registration so the server's copy carries the chosen name. */
  locale?: string;
  /** Injected in tests. Defaults to the global. */
  fetchImpl?: typeof fetch;
  /** Skips the push and only pulls. For a fresh device restoring its record. */
  pullOnly?: boolean;
}

/**
 * One sync round trip.
 *
 * A single POST does both directions: the response is the merged record, so
 * pushing and pulling in separate requests would double the round trips and
 * open a window where the two disagree.
 */
export async function syncNow(options: SyncOptions): Promise<SyncOutcome> {
  const { learnerName } = options;
  const doFetch = options.fetchImpl ?? fetch;

  const token = await ensureToken({
    displayName: learnerName,
    ...(options.locale !== undefined ? { locale: options.locale } : {}),
    fetchImpl: doFetch,
  });
  if (token === null) return { status: "deferred", reason: "no-token" };

  /**
   * Captured before the request, and cleared afterwards by value.
   *
   * A take scored while the request is in flight marks its language dirty
   * again, and clearing everything on success would drop that flag — leaving
   * the work sitting locally with nothing to say it was never sent.
   */
  const dirty = options.pullOnly === true
    ? { progress: [], skills: [], streak: false }
    : readDirty(learnerName);

  const body = {
    progress: dirty.progress.map((slug) => progressToWire(slug, readProgress(slug, learnerName))),
    skills: dirty.skills.map((slug) => skillsToWire(slug, readSkills(slug, learnerName))),
    ...(dirty.streak ? { streak: streakToWire(readStreak(learnerName)) } : {}),
  };

  let response: Response;
  try {
    response = await doFetch("/api/v1/sync", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch {
    // Offline, DNS, aborted. Nothing to report and nothing lost.
    return { status: "deferred", reason: "network" };
  }

  if (response.status === 401) {
    /**
     * The token is no longer accepted — expired, or the secret rotated. Drop
     * it so the next attempt registers again, which is cheap and gets the same
     * learner back, rather than retrying a credential that cannot work.
     */
    clearToken();
    return { status: "deferred", reason: "rejected" };
  }
  if (!response.ok) return { status: "deferred", reason: "rejected" };

  let snapshot: SyncSnapshot | null;
  try {
    snapshot = readSnapshot(await response.json());
  } catch {
    return { status: "deferred", reason: "bad-response" };
  }
  if (snapshot === null) {
    // Shaped like JSON but not like a snapshot — a captive portal, a proxy, a
    // stale service worker. Writing it over the local record would be worse
    // than doing nothing.
    return { status: "deferred", reason: "bad-response" };
  }

  applySnapshot(learnerName, snapshot);
  clearDirty(learnerName, dirty);

  return hasAnything(dirty) || snapshotHasContent(snapshot)
    ? { status: "synced", pushed: dirty }
    : { status: "nothing-to-do" };
}

function snapshotHasContent(snapshot: SyncSnapshot): boolean {
  return (
    snapshot.progress.some((p) => p.entries.length > 0) ||
    snapshot.skills.some((s) => s.skills.length > 0) ||
    snapshot.streak.days.length > 0
  );
}

/**
 * Folds a server snapshot into the local stores.
 *
 * Each language is written independently, so a malformed entry for one costs
 * that language and not the whole sync — the same reasoning the stores already
 * apply to a corrupt stored value.
 */
export function applySnapshot(learnerName: string | null, snapshot: SyncSnapshot): void {
  for (const incoming of snapshot.progress) {
    applyProgress(learnerName, incoming);
  }
  for (const incoming of snapshot.skills) {
    applySkills(learnerName, incoming);
  }
  if (snapshot.streak.days.length > 0 || snapshot.streak.longest > 0) {
    writeStreak(learnerName, {
      days: snapshot.streak.days,
      // Recomputed by writeStreak from the merged days; passed through so a
      // record that has aged out of the day list is not lost.
      current: 0,
      longest: snapshot.streak.longest,
    });
  }
}

function applyProgress(learnerName: string | null, incoming: WireProgress): void {
  const stored = readProgress(incoming.slug, learnerName);
  writeProgress(incoming.slug, learnerName, progressFromWire(stored, incoming));
}

function applySkills(learnerName: string | null, incoming: WireSkills): void {
  writeSkills(incoming.slug, learnerName, skillsFromWire(incoming));
}
