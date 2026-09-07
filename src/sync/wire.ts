/**
 * What crosses the wire, and the shapes on either side of it.
 *
 * The server sends a *summary* per activity, not the stored progress: the
 * local record carries every attempt's full provider result, which is
 * telemetry the attempts collection already has. Syncing it would move
 * kilobytes per activity to tell the server something it was told at scoring
 * time.
 *
 * That asymmetry is the reason this file exists rather than the shapes being
 * shared. Converting back has to *preserve the local attempts*, because the
 * server has no way to return them and a naive overwrite would delete a
 * learner's own take history from the device that recorded it.
 */

import type { ActivityAttempt } from "../activities/types.js";
import type { PersistedProgress } from "../hooks/useProgressPersistence.js";
import type { Skill, SkillStore } from "../stores/skillStore.js";
import type { Streak } from "../stores/streakStore.js";

/** One activity's outcome, as the server holds it. */
export interface WireProgressEntry {
  activityId: number;
  passed: boolean;
  bestAccuracy: number | null;
  attemptsUsed: number;
  skipped: boolean;
  at: string;
}

export interface WireProgress {
  slug: string;
  entries: WireProgressEntry[];
}

export interface WireSkills {
  slug: string;
  skills: Skill[];
}

export interface WireStreak {
  days: string[];
  longest: number;
}

export interface SyncSnapshot {
  progress: WireProgress[];
  skills: WireSkills[];
  streak: WireStreak;
}

/** The latest attempt timestamp on one activity, or null. */
function latestAttempt(attempts: ActivityAttempt[]): string | null {
  let latest: string | null = null;
  for (const attempt of attempts) {
    if (typeof attempt.at !== "string") continue;
    if (latest === null || attempt.at > latest) latest = attempt.at;
  }
  return latest;
}

/**
 * Local progress to the wire summary.
 *
 * Activities never attempted are dropped rather than sent as zeroes: an entry
 * saying "not passed, no attempts" is indistinguishable from no entry, and
 * sending them would push four languages of untouched activities on a learner's
 * first sync.
 */
export function progressToWire(slug: string, stored: PersistedProgress): WireProgress {
  const entries: WireProgressEntry[] = [];

  for (const entry of stored.progress) {
    const at = latestAttempt(entry.attempts);
    if (at === null && !entry.passed && !entry.skipped) continue;

    entries.push({
      activityId: entry.activityId,
      passed: entry.passed,
      bestAccuracy: entry.best,
      attemptsUsed: entry.attempts.length,
      skipped: entry.skipped,
      at: at ?? new Date(0).toISOString(),
    });
  }

  return { slug, entries: entries.sort((a, b) => a.activityId - b.activityId) };
}

/**
 * Folds a server summary back into local progress, keeping local attempts.
 *
 * The merge is the same monotonic rule the server applies, repeated here
 * because the client has to arrive at the same answer without a round trip:
 * `passed` OR, `best` MAX, `skipped` AND. Applying it locally as well is what
 * lets the UI update from a sync without waiting for another one.
 *
 * `attempts` is taken from local, always. The server does not have them, so
 * anything else deletes them.
 */
export function progressFromWire(
  stored: PersistedProgress,
  incoming: WireProgress,
): PersistedProgress {
  const byId = new Map(stored.progress.map((p) => [p.activityId, p]));

  for (const entry of incoming.entries) {
    const local = byId.get(entry.activityId);

    if (local === undefined) {
      // Known to the server, never seen here. The attempt list is genuinely
      // empty on this device rather than lost.
      byId.set(entry.activityId, {
        activityId: entry.activityId,
        attempts: [],
        best: entry.bestAccuracy,
        passed: entry.passed,
        skipped: entry.skipped,
      });
      continue;
    }

    byId.set(entry.activityId, {
      activityId: local.activityId,
      // Never replaced: the server has no copy of these.
      attempts: local.attempts,
      best:
        local.best === null
          ? entry.bestAccuracy
          : entry.bestAccuracy === null
            ? local.best
            : Math.max(local.best, entry.bestAccuracy),
      passed: local.passed || entry.passed,
      skipped: local.skipped && entry.skipped,
    });
  }

  return {
    // The stored index is where *this device* left off, and is not synced. A
    // second device's position is not this one's.
    index: stored.index,
    progress: [...byId.values()].sort((a, b) => a.activityId - b.activityId),
    finished: stored.finished,
  };
}

export function skillsToWire(slug: string, store: SkillStore): WireSkills {
  return {
    slug,
    skills: Object.values(store).map((skill) => ({
      grapheme: skill.grapheme,
      samples: skill.samples,
    })),
  };
}

/**
 * A server snapshot back into the local store shape.
 *
 * Overwriting is correct here, unlike progress: the server's samples are
 * already the union of every device's, including this one's, so they can only
 * ever be a superset of what is stored locally.
 */
export function skillsFromWire(incoming: WireSkills): SkillStore {
  const store: SkillStore = {};
  for (const skill of incoming.skills) {
    if (skill.grapheme.length === 0) continue;
    store[skill.grapheme] = { grapheme: skill.grapheme, samples: skill.samples };
  }
  return store;
}

export function streakToWire(streak: Streak): WireStreak {
  return { days: streak.days, longest: streak.longest };
}

/**
 * Reads a snapshot from an unknown response body.
 *
 * The server validates what it stores, and this validates what it is told —
 * because a proxy, a captive portal or a stale service worker can all return
 * something shaped like JSON, and this data is about to be written over a
 * learner's local record.
 */
export function readSnapshot(raw: unknown): SyncSnapshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const body = raw as { progress?: unknown; skills?: unknown; streak?: unknown };

  if (!Array.isArray(body.progress) || !Array.isArray(body.skills)) return null;
  if (typeof body.streak !== "object" || body.streak === null) return null;

  const streak = body.streak as { days?: unknown; longest?: unknown };
  if (!Array.isArray(streak.days)) return null;

  return {
    progress: body.progress.filter(isWireProgress),
    skills: body.skills.filter(isWireSkills),
    streak: {
      days: streak.days.filter((d): d is string => typeof d === "string"),
      longest: typeof streak.longest === "number" && Number.isFinite(streak.longest) ? streak.longest : 0,
    },
  };
}

function isWireProgress(value: unknown): value is WireProgress {
  if (typeof value !== "object" || value === null) return false;
  const c = value as { slug?: unknown; entries?: unknown };
  return typeof c.slug === "string" && c.slug.length > 0 && Array.isArray(c.entries);
}

function isWireSkills(value: unknown): value is WireSkills {
  if (typeof value !== "object" || value === null) return false;
  const c = value as { slug?: unknown; skills?: unknown };
  return typeof c.slug === "string" && c.slug.length > 0 && Array.isArray(c.skills);
}
