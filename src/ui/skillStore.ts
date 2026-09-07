/**
 * A sound the learner owns, carried across sessions.
 *
 * Every ingredient for this already existed and was thrown away when the tab
 * closed: syllable accuracy on every word of every attempt, keyed by grapheme,
 * already pooled per session by `report.ts`. Persisting it is the difference
 * between a product that scores takes and one that can say
 * *"‑ent is at 61, up from 48 last week"* — which is a reason to come back
 * that no streak can manufacture.
 *
 * Deliberately **not** a score, and the type keeps saying so. This is a mean
 * of past accuracies for one written syllable. It decides nothing: it does not
 * gate an activity, it is not shown as a pass mark, and it never replaces the
 * number the provider returned for the take in front of the learner.
 *
 * localStorage, matching the progress store — same key shape, same schema
 * version in the key, same rule that a version bump orphans old data rather
 * than reading it. Per language *and* per learner, because a shared device
 * runs several speakers and pooling their sounds would describe nobody.
 */

/**
 * Bumped when the stored shape changes in a way older data cannot satisfy.
 * Part of the key, so a bump orphans the old entry instead of parsing it.
 */
const SCHEMA_VERSION = "v1";

/**
 * Samples kept per syllable.
 *
 * Bounded on purpose: this grows every take, forever, in a store with a few
 * megabytes to its name. Twenty is enough to separate a recent mean from an
 * older one — which is the only question asked of it — and keeps a learner who
 * has practised for a year from carrying a thousand numbers per sound.
 */
const MAX_SAMPLES = 20;

/**
 * How many of the most recent samples count as "now" when reporting a trend.
 * Below this there is no trend worth stating, only noise.
 */
const RECENT_WINDOW = 5;

export interface SkillSample {
  /** ISO timestamp, so a trend can be described in days rather than takes. */
  at: string;
  accuracy: number;
}

export interface Skill {
  /** The written syllable, e.g. "ment". Never a phonetic symbol. */
  grapheme: string;
  samples: SkillSample[];
}

export interface SkillTrend {
  grapheme: string;
  /** Mean of the recent window. */
  now: number;
  /**
   * Mean of everything before it, or null when there is not enough history to
   * compare against. Null is the honest answer for a first week and must not
   * be rendered as "no change".
   */
  before: number | null;
  /** Total samples behind `now` and `before` together. */
  samples: number;
}

export type SkillStore = Record<string, Skill>;

function storageKey(slug: string, learnerName: string | null): string {
  return `sonare.skills.${SCHEMA_VERSION}.${slug}.${learnerName ?? "anonymous"}`;
}

/** A sample that survived validation, or null. */
function readSample(raw: unknown): SkillSample | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Partial<SkillSample>;
  if (typeof candidate.at !== "string") return null;
  if (typeof candidate.accuracy !== "number" || !Number.isFinite(candidate.accuracy)) return null;
  return { at: candidate.at, accuracy: candidate.accuracy };
}

/**
 * Reads the store, validating every field.
 *
 * `JSON.parse(...) as T` is a claim, not a check, and this data outlives the
 * type that described it — the progress store crashed the whole activity
 * screen on exactly that assumption. Anything malformed is dropped rather than
 * trusted, so a corrupt entry costs one syllable's history and not the screen.
 */
export function readSkills(slug: string, learnerName: string | null): SkillStore {
  let raw: string | null;
  try {
    raw = localStorage.getItem(storageKey(slug, learnerName));
  } catch {
    // Private browsing, or storage disabled. No history is a fine answer.
    return {};
  }
  if (raw === null) return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: SkillStore = {};
    for (const [grapheme, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof grapheme !== "string" || grapheme.length === 0) continue;
      const samples = (value as { samples?: unknown }).samples;
      if (!Array.isArray(samples)) continue;
      const clean = samples.map(readSample).filter((s): s is SkillSample => s !== null);
      if (clean.length > 0) out[grapheme] = { grapheme, samples: clean.slice(-MAX_SAMPLES) };
    }
    return out;
  } catch {
    return {};
  }
}

/** Written syllables from one take. Unnamed ones are skipped — see below. */
export interface RecordableSyllable {
  grapheme: string;
  accuracy: number;
}

/**
 * Folds one take's syllables into the store and saves it.
 *
 * Unnamed syllables are skipped, not pooled. Azure returns an empty grapheme
 * where it could not map one — always for Hindi, and around elision and
 * hyphenation in French — and every one of those would land in a single ""
 * bucket presented as the learner's weakest sound. The same reasoning
 * `report.ts` already applies within a session.
 *
 * Case-folded, so a sentence-initial "Bon" and a mid-phrase "bon" are one
 * sound rather than two histories of half the length each.
 */
export function recordSkills(
  slug: string,
  learnerName: string | null,
  syllables: RecordableSyllable[],
  at: string = new Date().toISOString(),
): SkillStore {
  const store = readSkills(slug, learnerName);

  for (const syllable of syllables) {
    const grapheme = syllable.grapheme.trim().toLocaleLowerCase();
    if (grapheme.length === 0) continue;
    if (!Number.isFinite(syllable.accuracy)) continue;

    const existing = store[grapheme] ?? { grapheme, samples: [] };
    existing.samples = [...existing.samples, { at, accuracy: syllable.accuracy }].slice(-MAX_SAMPLES);
    store[grapheme] = existing;
  }

  try {
    localStorage.setItem(storageKey(slug, learnerName), JSON.stringify(store));
  } catch {
    // Quota, or storage disabled. The session continues on what is in memory;
    // only the history across sessions is lost, which is the right thing to
    // sacrifice.
  }

  return store;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * The trend for one syllable, or null when there is nothing to compare.
 *
 * `before` is null until there is history either side of the window. Reporting
 * a first week as "no change" would be inventing a comparison, and a learner
 * reading "no change" on their first Tuesday has been told something false.
 */
export function trendFor(store: SkillStore, grapheme: string): SkillTrend | null {
  const skill = store[grapheme.trim().toLocaleLowerCase()];
  if (skill === undefined || skill.samples.length === 0) return null;

  const recent = skill.samples.slice(-RECENT_WINDOW);
  const older = skill.samples.slice(0, -RECENT_WINDOW);

  return {
    grapheme: skill.grapheme,
    now: mean(recent.map((s) => s.accuracy)),
    before: older.length >= 2 ? mean(older.map((s) => s.accuracy)) : null,
    samples: skill.samples.length,
  };
}

/**
 * Weakest syllables first, for the one line a home screen shows.
 *
 * Requires `MIN_SAMPLES` occurrences before a sound counts as a weakness — one
 * bad take is not a pattern, and telling a learner their worst sound is
 * something they fluffed once would send them to practise the wrong thing. The
 * same threshold `report.ts` uses within a session, for the same reason.
 */
const MIN_SAMPLES = 2;

export function weakestSkills(store: SkillStore, limit = 3): SkillTrend[] {
  return Object.keys(store)
    .map((grapheme) => trendFor(store, grapheme))
    .filter((trend): trend is SkillTrend => trend !== null && trend.samples >= MIN_SAMPLES)
    .sort((a, b) => a.now - b.now)
    .slice(0, limit);
}

/** Forgets a learner's history for one language. */
export function clearSkills(slug: string, learnerName: string | null): void {
  try {
    localStorage.removeItem(storageKey(slug, learnerName));
  } catch {
    // Best effort — the caller's in-memory reset still happens.
  }
}
