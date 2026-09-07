/**
 * Which domains have local changes the server has not seen.
 *
 * Persisted rather than held in memory, and that is the whole point: a learner
 * who finishes an activity on a train and closes the tab before the push
 * succeeds must still have it pushed tomorrow. An in-memory flag loses exactly
 * the work that was hardest to do.
 *
 * Deliberately coarse — a domain, not a diff. Every merge is a union or a
 * monotonic maximum, so re-sending a whole domain is harmless and idempotent;
 * tracking which activity changed would buy a smaller request and cost a
 * second thing that can be wrong.
 */

/** In the key, so a shape change orphans the old flags rather than misreading. */
const SCHEMA_VERSION = "v1";

function storageKey(learnerName: string | null): string {
  return `sonare.sync.dirty.${SCHEMA_VERSION}.${learnerName ?? "anonymous"}`;
}

/**
 * Domains awaiting a push.
 *
 * A slug is carried alongside `progress` and `skills` because both are stored
 * per language, and a learner who practised French must not have their Spanish
 * pushed as well — the request is bounded, and pushing a language that has not
 * changed spends a read-modify-write for nothing.
 */
export interface DirtyState {
  /** Language slugs with unpushed progress. */
  progress: string[];
  /** Language slugs with unpushed skill samples. */
  skills: string[];
  /** The streak is per learner, so it is a flag rather than a list. */
  streak: boolean;
}

const EMPTY: DirtyState = { progress: [], skills: [], streak: false };

export function readDirty(learnerName: string | null): DirtyState {
  let raw: string | null;
  try {
    raw = localStorage.getItem(storageKey(learnerName));
  } catch {
    // Storage disabled. Nothing is known to be dirty, which means a sync will
    // push nothing rather than pushing everything — the safe direction, since
    // the alternative is a full push on every call.
    return EMPTY;
  }
  if (raw === null) return EMPTY;

  try {
    const parsed = JSON.parse(raw) as Partial<DirtyState>;
    return {
      progress: Array.isArray(parsed.progress) ? [...new Set(parsed.progress.filter(isSlug))] : [],
      skills: Array.isArray(parsed.skills) ? [...new Set(parsed.skills.filter(isSlug))] : [],
      streak: parsed.streak === true,
    };
  } catch {
    return EMPTY;
  }
}

/** Slug shape, so a corrupt flag cannot make the client request nonsense. */
function isSlug(value: unknown): value is string {
  return typeof value === "string" && /^[a-z]{2,16}$/.test(value);
}

function write(learnerName: string | null, state: DirtyState): void {
  try {
    localStorage.setItem(storageKey(learnerName), JSON.stringify(state));
  } catch {
    // Quota or private browsing. The push still happens this session; only
    // its survival across a reload is lost.
  }
}

/**
 * Marks a language's progress and skills as changed.
 *
 * Called after a take is scored, which is the only moment either can change.
 * Both together because a scored take always produces both — a progress
 * update and new syllable samples — so a caller cannot mark one and forget the
 * other.
 */
export function markLanguageDirty(learnerName: string | null, slug: string): void {
  if (!isSlug(slug)) return;
  const state = readDirty(learnerName);

  write(learnerName, {
    progress: [...new Set([...state.progress, slug])],
    skills: [...new Set([...state.skills, slug])],
    streak: state.streak,
  });
}

/** Marks the practice day as changed. Separate, since it is per learner. */
export function markStreakDirty(learnerName: string | null): void {
  const state = readDirty(learnerName);
  write(learnerName, { ...state, streak: true });
}

/**
 * Clears exactly what was pushed, not everything.
 *
 * A take scored *during* the request would otherwise have its flag cleared by
 * a push that did not include it, and the work would sit locally forever with
 * nothing marking it unsent. So the caller passes back the state it actually
 * sent, and only that is subtracted.
 */
export function clearDirty(learnerName: string | null, pushed: DirtyState): void {
  const state = readDirty(learnerName);

  write(learnerName, {
    progress: state.progress.filter((slug) => !pushed.progress.includes(slug)),
    skills: state.skills.filter((slug) => !pushed.skills.includes(slug)),
    // Only cleared if the push carried it, for the same reason.
    streak: pushed.streak ? false : state.streak,
  });
}

export function hasAnything(state: DirtyState): boolean {
  return state.progress.length > 0 || state.skills.length > 0 || state.streak;
}

/** For a reset or a deletion request. */
export function clearAllDirty(learnerName: string | null): void {
  try {
    localStorage.removeItem(storageKey(learnerName));
  } catch {
    // Best effort.
  }
}
