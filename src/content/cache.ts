/**
 * Content fetched from the server, cached so it survives being offline.
 *
 * Lives here rather than in `src/activities/` deliberately. That directory is
 * a **DOM-free zone** — `tsconfig.scripts.json` includes it so Node scripts
 * can import the content sets — so anything reaching for `localStorage` there
 * breaks the scripts build. `nextUp.ts` made exactly that mistake once and the
 * typecheck caught it; this is the same line, respected up front.
 *
 * The cache is what makes served content compatible with working offline. A
 * learner who has been online once has the latest phrases stored locally, so
 * the next session on a train uses them rather than falling all the way back
 * to whatever the app was built with. A learner who has never been online
 * falls back to the bundle, which is why the bundle stays.
 */

import type { Activity, LanguageActivitySet } from "../activities/types.js";

/** In the key, so a shape change orphans the old cache rather than misreading it. */
const SCHEMA_VERSION = "v1";

const STORAGE_KEY = `sonare.content.${SCHEMA_VERSION}`;

/** A cached set carries the version it came from, for diagnostics and staleness. */
export interface CachedSet extends LanguageActivitySet {
  version: number;
}

export type ContentCache = Record<string, CachedSet>;

/**
 * Validates an activity, rather than trusting it.
 *
 * This is a phrase a learner will be asked to say aloud and scored against.
 * A missing `target` means scoring speech against nothing, and a missing
 * `prompt` means an activity with no instruction — both worth refusing here
 * rather than discovering on screen. The server validates on the way out too;
 * this is the client refusing to be the weak end of that.
 */
function readActivity(raw: unknown): Activity | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;

  if (typeof c["id"] !== "number" || !Number.isFinite(c["id"])) return null;
  const kind = c["kind"];
  if (kind !== "repeat" && kind !== "respond" && kind !== "read") return null;

  for (const field of ["title", "prompt", "gloss", "target", "focus"]) {
    if (typeof c[field] !== "string" || (c[field] as string).length === 0) return null;
  }

  return {
    id: Math.trunc(c["id"]),
    title: c["title"] as string,
    kind,
    prompt: c["prompt"] as string,
    gloss: c["gloss"] as string,
    target: c["target"] as string,
    focus: c["focus"] as string,
  };
}

/**
 * A whole set, or null.
 *
 * A set with no usable activities is refused rather than cached empty. An
 * empty language reads to a learner as a broken app, and caching one would
 * replace a working bundled set with nothing — the exact failure the fallback
 * exists to prevent.
 */
export function readCachedSet(raw: unknown): CachedSet | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;

  if (typeof c["slug"] !== "string" || !/^[a-z]{2,16}$/.test(c["slug"])) return null;
  if (typeof c["code"] !== "string" || c["code"].length === 0) return null;
  if (typeof c["label"] !== "string" || c["label"].length === 0) return null;
  if (typeof c["version"] !== "number" || !Number.isInteger(c["version"]) || c["version"] < 1) {
    return null;
  }
  if (!Array.isArray(c["activities"])) return null;

  const activities = c["activities"].map(readActivity).filter((a): a is Activity => a !== null);
  if (activities.length === 0) return null;

  return {
    slug: c["slug"],
    code: c["code"],
    label: c["label"],
    version: c["version"],
    activities,
  };
}

/** Everything cached, validated. Empty on anything unreadable. */
export function readCache(): ContentCache {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private browsing or storage disabled. The bundle is a fine answer.
    return {};
  }
  if (raw === null) return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};

    const out: ContentCache = {};
    for (const value of Object.values(parsed as Record<string, unknown>)) {
      const set = readCachedSet(value);
      // Keyed by the set's own slug rather than the object key, so a
      // hand-edited or corrupt key cannot make one language masquerade as
      // another.
      if (set !== null) out[set.slug] = set;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Stores one language's set, leaving the others alone.
 *
 * Merged rather than replaced because the four languages are fetched
 * independently: a failure on one must not evict the three that succeeded.
 */
export function writeCachedSet(set: CachedSet): void {
  const cache = readCache();
  cache[set.slug] = set;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Quota, or storage disabled. The session still uses what it fetched;
    // only its survival to the next visit is lost.
  }
}

/** For a reset or a deletion request. */
export function clearCache(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Best effort.
  }
}
