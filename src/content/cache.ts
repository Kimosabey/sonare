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

import {
  ACTIVITY_KINDS,
  MAX_LESSON_ACTIVITIES,
  MIN_LESSON_ACTIVITIES,
  type Activity,
  type ActivityKind,
  type LanguageActivitySet,
  type Lesson,
  type Unit,
} from "../activities/types.js";

/**
 * In the key, so a shape change orphans the old cache rather than misreading
 * it.
 *
 * **Deliberately still v1 after the course spine landed**, because that change
 * is readable in both directions rather than a reinterpretation. A set cached
 * before units existed has no `units` and no `soundTargets`, which is exactly
 * what this code reads as "flat language, no spine" — the shape three of the
 * four shipped languages still have. And a set cached by this version is read
 * by the previous one as the flat list it also is, because the spine points
 * into `activities` rather than replacing it.
 *
 * Bumping it would have been the safe-looking move and the wrong one: it
 * evicts every learner's cached content and sends them back to the bundle
 * until the next successful fetch, to solve a misreading that cannot happen.
 */
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
  /**
   * Checked against the exported list rather than a hand-written union. This
   * check and `ActivityKind` used to be two copies of the same three strings,
   * and adding a fourth kind (`recall`) to one of them would have left served
   * content silently discarded by this function while the type said it was
   * fine.
   */
  const kind = c["kind"];
  if (typeof kind !== "string" || !(ACTIVITY_KINDS as readonly string[]).includes(kind)) return null;

  for (const field of ["title", "prompt", "gloss", "target", "focus"]) {
    if (typeof c[field] !== "string" || (c[field] as string).length === 0) return null;
  }

  /**
   * Sound targets are filtered, never grounds for refusal. An unreadable entry
   * costs the scheduler a mapping it never had; dropping the activity over one
   * would cost the learner a phrase. The publish gate is where a bad one is
   * named and refused.
   */
  const rawSounds = c["soundTargets"];
  const soundTargets = Array.isArray(rawSounds)
    ? rawSounds.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    : [];

  return {
    id: Math.trunc(c["id"]),
    title: c["title"] as string,
    kind: kind as ActivityKind,
    prompt: c["prompt"] as string,
    gloss: c["gloss"] as string,
    target: c["target"] as string,
    focus: c["focus"] as string,
    ...(soundTargets.length > 0 ? { soundTargets } : {}),
  };
}

/**
 * The spine, read strictly — all of it or none of it.
 *
 * The opposite posture to everything else here, and deliberately. A dropped
 * activity costs one phrase. A dropped *lesson* leaves a journey with a hole
 * in it that nothing on screen would explain, so an unreadable spine falls
 * back to no spine: the flat list in order, which is the shape that shipped
 * and that every screen already handles.
 *
 * Mirrors `readUnits` in server/store/content.ts — the same deliberate
 * duplication the content types already follow across that boundary, and with
 * the same guarantee: this end can refuse something the server would serve,
 * which costs a spine; it cannot accept something the server refuses.
 */
function readUnits(raw: unknown, known: ReadonlySet<number>): Unit[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const unitIds = new Set<number>();
  const lessonIds = new Set<number>();
  const covered = new Set<number>();
  const units: Unit[] = [];

  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return null;
    const u = entry as Record<string, unknown>;

    const id = u["id"];
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1 || unitIds.has(id)) return null;
    unitIds.add(id);

    const title = u["title"];
    const outcome = u["outcome"];
    if (typeof title !== "string" || title.trim().length === 0) return null;
    if (typeof outcome !== "string" || outcome.trim().length === 0) return null;

    const rawLessons = u["lessons"];
    if (!Array.isArray(rawLessons) || rawLessons.length === 0) return null;

    const lessons: Lesson[] = [];
    for (const lessonEntry of rawLessons) {
      if (typeof lessonEntry !== "object" || lessonEntry === null) return null;
      const l = lessonEntry as Record<string, unknown>;

      const lessonId = l["id"];
      if (typeof lessonId !== "number" || !Number.isInteger(lessonId) || lessonId < 1) return null;
      if (lessonIds.has(lessonId)) return null;
      lessonIds.add(lessonId);

      const lessonTitle = l["title"];
      const lessonOutcome = l["outcome"];
      if (typeof lessonTitle !== "string" || lessonTitle.trim().length === 0) return null;
      if (typeof lessonOutcome !== "string" || lessonOutcome.trim().length === 0) return null;

      const activityIds = l["activityIds"];
      if (!Array.isArray(activityIds)) return null;
      if (activityIds.length < MIN_LESSON_ACTIVITIES) return null;
      if (activityIds.length > MAX_LESSON_ACTIVITIES) return null;

      for (const activityId of activityIds) {
        if (typeof activityId !== "number" || !known.has(activityId)) return null;
        // One take must not read as progress in two lessons.
        if (covered.has(activityId)) return null;
        covered.add(activityId);
      }

      lessons.push({
        id: lessonId,
        title: lessonTitle,
        outcome: lessonOutcome,
        activityIds: activityIds as number[],
      });
    }

    units.push({ id, title, outcome, lessons });
  }

  // An activity in no lesson can never be reached from the journey.
  if (covered.size !== known.size) return null;

  return units;
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

  // Read against the activities that survived, so a lesson pointing at one
  // that was dropped takes the spine with it rather than producing a sitting
  // that ends early on a blank screen.
  const units =
    c["units"] === undefined ? null : readUnits(c["units"], new Set(activities.map((a) => a.id)));

  return {
    slug: c["slug"],
    code: c["code"],
    label: c["label"],
    version: c["version"],
    activities,
    ...(units === null ? {} : { units }),
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
