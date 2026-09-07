/**
 * How two devices' records are combined. Pure, no I/O.
 *
 * The merge rule is the whole design of sync, and a blanket last-write-wins
 * would be actively wrong for most of it — wrong in a way nobody notices until
 * they use a second device, and then loses work they did.
 *
 * Every rule here is chosen so that merging **commutes**: the result does not
 * depend on which device pushed first, so there is no conflict to resolve and
 * no learner ever has to be asked about their own practice. That is why each
 * domain is either a set union, a monotonic maximum, or a genuine preference,
 * and why none of them needs a vector clock or a CRDT library.
 */

/**
 * One activity's outcome, as it crosses the wire.
 *
 * Deliberately a summary, not the stored `ActivityProgress`. That carries the
 * full provider result for every attempt, which is telemetry — it belongs in
 * the attempts collection, which already has it, and syncing it would move
 * kilobytes per activity to tell the server something it was told at scoring
 * time.
 */
export interface ProgressEntry {
  activityId: number;
  passed: boolean;
  /** The provider's number, stored and never recomputed (R3). Null if never scored. */
  bestAccuracy: number | null;
  attemptsUsed: number;
  /** Advanced without passing, after exhausting attempts. */
  skipped: boolean;
  /** ISO timestamp of the most recent attempt on this activity. */
  at: string;
}

export interface ProgressState {
  slug: string;
  entries: ProgressEntry[];
}

/** The larger of two bests, treating "never scored" as no claim rather than zero. */
function bestOf(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/** The later of two ISO strings. Lexicographic order is chronological for ISO. */
function laterOf(a: string, b: string): string {
  return a > b ? a : b;
}

/**
 * Combines one activity's outcome from two devices.
 *
 * Monotonic in every field, which is what makes it commutative:
 *
 * `passed` is OR. Last-write-wins here could *un-pass* an activity — a phone
 * that synced before the learner passed it would overwrite the tablet that
 * recorded the pass, and the learner would find work they had done undone.
 *
 * `bestAccuracy` is MAX, because it is a best. Never averaged and never
 * recomputed from anything: it is the number the provider returned.
 *
 * `attemptsUsed` is MAX rather than a sum. Two devices each recording two
 * attempts is not four tries against a limit of three — it is the same
 * learner, and summing would lock them out of an activity they have two tries
 * left on.
 *
 * `skipped` is AND, so it survives only if both devices agree. A device that
 * skipped an activity the learner later went back and passed elsewhere must
 * not keep it marked skipped.
 */
export function mergeEntry(mine: ProgressEntry, theirs: ProgressEntry): ProgressEntry {
  return {
    activityId: mine.activityId,
    passed: mine.passed || theirs.passed,
    bestAccuracy: bestOf(mine.bestAccuracy, theirs.bestAccuracy),
    attemptsUsed: Math.max(mine.attemptsUsed, theirs.attemptsUsed),
    skipped: mine.skipped && theirs.skipped,
    at: laterOf(mine.at, theirs.at),
  };
}

/**
 * Combines a whole language's progress.
 *
 * An activity present on only one side is taken as it is — the other device
 * simply has not seen it, which is not evidence against it.
 */
export function mergeProgress(mine: ProgressState, theirs: ProgressState): ProgressState {
  const byId = new Map<number, ProgressEntry>();

  for (const entry of mine.entries) byId.set(entry.activityId, entry);
  for (const entry of theirs.entries) {
    const existing = byId.get(entry.activityId);
    byId.set(entry.activityId, existing === undefined ? entry : mergeEntry(existing, entry));
  }

  return {
    slug: mine.slug,
    // Sorted, so two devices that merged the same facts produce byte-identical
    // documents. Without it the same state has many representations and a
    // "did anything change" check can never be cheap.
    entries: [...byId.values()].sort((a, b) => a.activityId - b.activityId),
  };
}

/** Rejects anything that is not a `ProgressEntry`, rather than trusting it. */
export function readProgressEntry(raw: unknown): ProgressEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Partial<ProgressEntry>;

  if (typeof c.activityId !== "number" || !Number.isFinite(c.activityId)) return null;
  if (typeof c.at !== "string" || c.at.length === 0 || c.at.length > 40) return null;

  const best =
    typeof c.bestAccuracy === "number" && Number.isFinite(c.bestAccuracy)
      ? // Clamped, because this is shown to a learner as their score and the
        // value arrives from a client that can send anything. A stored 8000
        // would render as an impossible best and, being a MAX, would never be
        // displaced by a real one.
        Math.min(100, Math.max(0, c.bestAccuracy))
      : null;

  return {
    activityId: Math.trunc(c.activityId),
    passed: c.passed === true,
    bestAccuracy: best,
    // Clamped for the same reason in the other direction: a negative or absurd
    // count is a MAX that would either do nothing or lock the activity.
    attemptsUsed:
      typeof c.attemptsUsed === "number" && Number.isFinite(c.attemptsUsed)
        ? Math.min(999, Math.max(0, Math.trunc(c.attemptsUsed)))
        : 0,
    skipped: c.skipped === true,
    at: c.at,
  };
}

/** Slug shape, so a client cannot make one up that keys a strange document. */
const SLUG = /^[a-z]{2,16}$/;

export function isSlug(value: unknown): value is string {
  return typeof value === "string" && SLUG.test(value);
}

/** Bounded so one push cannot store an unbounded document. */
const MAX_ENTRIES = 200;

export function readProgressState(raw: unknown): ProgressState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as { slug?: unknown; entries?: unknown };
  if (!isSlug(c.slug)) return null;
  if (!Array.isArray(c.entries)) return null;

  const entries = c.entries
    .map(readProgressEntry)
    .filter((e): e is ProgressEntry => e !== null)
    .slice(0, MAX_ENTRIES);

  return { slug: c.slug, entries };
}
