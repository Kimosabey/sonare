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
 * Collapses both sides of a merge into one entry per key, symmetrically.
 *
 * Each of the three merges below is a keyed union — activity id, grapheme,
 * timestamp — and each of them used to load `mine` with a plain assignment and
 * only combine on the `theirs` pass. So a repeated key was folded on one side
 * and silently last-write-wins on the other, which made every one of them
 * non-commutative on any input carrying a duplicate: merging `a` into `b`
 * combined a's repeats and discarded b's, and the other way round did the
 * reverse. Generated inputs found it immediately (merge.laws.test.ts) — two
 * entries for one activity produced `attemptsUsed: 2` one way round and `0`
 * the other, which is a real attempt count vanishing on the arrival order.
 *
 * Nothing rules those inputs out. `readProgressState` never deduplicates
 * `entries` by `activityId`, `readSkill` never deduplicates `samples` by `at`,
 * and stored state arrives through a `fromDocument` that hands back whatever
 * the document holds — including a shape written by an older build. Folding
 * both sides through the same combiner makes the result depend only on the
 * multiset of entries, which is what the commutativity claim needs.
 *
 * `combine(item, item)` on a key's first sighting is deliberate, and it is not
 * a wasted call. Every combiner here is idempotent, so it is a no-op on an
 * already-canonical item — and it is the *only* thing that canonicalises a
 * nested duplicate. A grapheme appearing on one side only was otherwise
 * passed through untouched, carrying two samples for one timestamp into the
 * stored document, and re-applying the same push then collapsed them: the
 * merge was not idempotent, so a retry changed the record. Normalising on
 * sight is what makes the output a fixpoint whatever the input looked like.
 */
function foldByKey<K, V>(into: Map<K, V>, items: readonly V[], keyOf: (item: V) => K, combine: (a: V, b: V) => V): void {
  for (const item of items) {
    const key = keyOf(item);
    into.set(key, combine(into.get(key) ?? item, item));
  }
}

/**
 * The slug both sides are talking about.
 *
 * Taking `mine.slug` unconditionally was wrong in one reachable case. Every
 * store's `fromDocument` yields `""` for a document written before the field
 * existed (store/progress.ts, store/skills.ts) — deliberately, so an older
 * shape does not throw — and merging that stored state with a real push then
 * produced `slug: ""`, which the store wrote straight back into a document
 * whose `_id` says `{learner}:fr`. One merge was enough to make the field
 * permanently blank, and a pull then handed the client a language with no
 * name.
 *
 * Deferring to whichever side has one also makes the choice independent of
 * argument order, which is the property the rest of this file is built on. Two
 * different non-empty slugs cannot arrive here: the document id is derived
 * from the slug, so both sides of a merge are by construction the same
 * language.
 */
function slugOf(mine: string, theirs: string): string {
  return mine.length > 0 ? mine : theirs;
}

/**
 * Entries kept, bounding both one push and the stored union.
 *
 * `readProgressState` trims an incoming push to this; `mergeProgress` trims
 * the merged result to the same number, which is what actually bounds the
 * document — see the note there.
 */
const MAX_ENTRIES = 200;

/**
 * Combines a whole language's progress.
 *
 * An activity present on only one side is taken as it is — the other device
 * simply has not seen it, which is not evidence against it.
 *
 * Capped, and the cap is not decoration. `readProgressState` bounds one *push*
 * to MAX_ENTRIES, but the union here is what gets stored, so a client sending
 * a fresh batch of activity ids each time grew the document without limit —
 * 200 entries a push, no ceiling, until it met Mongo's 16MB document cap and
 * the learner's progress stopped saving. `mergeSkills` below already bounded
 * itself the same way; this one simply did not.
 *
 * Trimming the *highest* ids keeps the activities a learner is working through
 * rather than whichever arrived last, and — being a bounded prefix of a total
 * order — it leaves the merge commutative: what survives depends on the set of
 * entries, never on the order they were merged in.
 */
export function mergeProgress(mine: ProgressState, theirs: ProgressState): ProgressState {
  const byId = new Map<number, ProgressEntry>();
  const idOf = (entry: ProgressEntry): number => entry.activityId;

  foldByKey(byId, mine.entries, idOf, mergeEntry);
  foldByKey(byId, theirs.entries, idOf, mergeEntry);

  return {
    slug: slugOf(mine.slug, theirs.slug),
    // Sorted, so two devices that merged the same facts produce byte-identical
    // documents. Without it the same state has many representations and a
    // "did anything change" check can never be cheap.
    entries: [...byId.values()].sort((a, b) => a.activityId - b.activityId).slice(0, MAX_ENTRIES),
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

/* ── skills ─────────────────────────────────────────────────────────────── */

export interface SkillSample {
  /** ISO timestamp. Doubles as the identity of the sample when merging. */
  at: string;
  accuracy: number;
}

export interface Skill {
  /** The written syllable, e.g. "ment". Never a phonetic symbol. */
  grapheme: string;
  samples: SkillSample[];
}

export interface SkillState {
  slug: string;
  skills: Skill[];
}

/**
 * Samples kept per syllable, matching the client's own cap.
 *
 * Bounded because this grows on every take, forever. Twenty is enough to
 * separate a recent mean from an older one, which is the only question asked
 * of it.
 */
const MAX_SAMPLES = 20;

/** Graphemes kept, so one push cannot store an unbounded document. */
const MAX_GRAPHEMES = 400;

/**
 * Two reports of one take, reduced to one sample.
 *
 * The higher accuracy wins, and the rule has to be about the two *values*
 * rather than about which argument they arrived in. "First writer wins" was
 * here instead, described in a comment as commutative because it was
 * deterministic — which is not the same thing. For a single pair,
 * `mergeSkill(a, b)` kept 10 and `mergeSkill(b, a)` kept 90, so the accuracy
 * stored for a sound depended on which device's push reached the server
 * first: no lost race, no error, and nothing in the data to say a choice had
 * been made at all.
 *
 * A maximum, matching `bestOf` above and the "monotonic maximum" shape this
 * module is built from. Samples sharing a timestamp are the same take
 * described twice, so neither number is wrong; a maximum is simply the choice
 * that does not depend on the order.
 */
function higherOf(a: SkillSample, b: SkillSample): SkillSample {
  return { at: a.at, accuracy: Math.max(a.accuracy, b.accuracy) };
}

/**
 * Union of two syllables' sample histories.
 *
 * A union keyed on the timestamp, **not** last-write-wins. Under LWW the
 * device that synced second would replace the other's history rather than add
 * to it, and a learner practising on a phone and a laptop would keep losing
 * half their evidence — while every screen still showed a plausible-looking
 * trend, computed from a fraction of the takes.
 *
 * Deduplicated on `at` because the same take pushed twice is one take. A retry
 * after a timeout must not double a sample and quietly weight it.
 *
 * Sorted oldest-first and then trimmed from the front, so the cap discards the
 * least useful samples rather than whichever arrived last.
 */
export function mergeSkill(mine: Skill, theirs: Skill): Skill {
  const byTime = new Map<string, SkillSample>();
  const timeOf = (sample: SkillSample): string => sample.at;

  foldByKey(byTime, mine.samples, timeOf, higherOf);
  foldByKey(byTime, theirs.samples, timeOf, higherOf);

  return {
    grapheme: mine.grapheme,
    samples: [...byTime.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).slice(-MAX_SAMPLES),
  };
}

export function mergeSkills(mine: SkillState, theirs: SkillState): SkillState {
  const byGrapheme = new Map<string, Skill>();
  const graphemeOf = (skill: Skill): string => skill.grapheme;

  foldByKey(byGrapheme, mine.skills, graphemeOf, mergeSkill);
  foldByKey(byGrapheme, theirs.skills, graphemeOf, mergeSkill);

  return {
    slug: slugOf(mine.slug, theirs.slug),
    skills: [...byGrapheme.values()]
      .sort((a, b) => (a.grapheme < b.grapheme ? -1 : a.grapheme > b.grapheme ? 1 : 0))
      .slice(0, MAX_GRAPHEMES),
  };
}

function readSample(raw: unknown): SkillSample | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Partial<SkillSample>;
  if (typeof c.at !== "string" || c.at.length === 0 || c.at.length > 40) return null;
  if (typeof c.accuracy !== "number" || !Number.isFinite(c.accuracy)) return null;
  // Clamped: this is averaged into a figure shown to a learner as how well
  // they say a sound, and it arrives from a client that can send anything.
  return { at: c.at, accuracy: Math.min(100, Math.max(0, c.accuracy)) };
}

/**
 * Written syllables: letters, combining marks, apostrophes and hyphens.
 *
 * Combining marks are kept deliberately — Devanagari matras are marks, and
 * stripping them as punctuation is a mistake this project has already made
 * once. The guard rejects structural junk (markup, digits, spaces, paths,
 * anything over-long), not phonetic symbols: those are Unicode letters too,
 * excluding them by codepoint block would be fragile, and a grapheme comes
 * from the reference text's own orthography so one never arrives here.
 */
const GRAPHEME = /^[\p{L}\p{M}'\u2019-]{1,24}$/u;

export function readSkill(raw: unknown): Skill | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as { grapheme?: unknown; samples?: unknown };
  if (typeof c.grapheme !== "string") return null;

  /**
   * Case-folded, so a sentence-initial "Bon" and a mid-phrase "bon" are one
   * sound rather than two histories of half the length each.
   */
  const grapheme = c.grapheme.trim().toLocaleLowerCase();

  /**
   * An unnamed syllable is dropped, never pooled. Azure returns an empty
   * grapheme where it could not map one — always for Hindi, and around elision
   * and hyphenation in French — and every one of those would land in a single
   * "" bucket that gets presented to the learner as their weakest sound.
   */
  if (grapheme.length === 0 || !GRAPHEME.test(grapheme)) return null;
  if (!Array.isArray(c.samples)) return null;

  const samples = c.samples
    .map(readSample)
    .filter((s): s is SkillSample => s !== null)
    .slice(-MAX_SAMPLES);
  if (samples.length === 0) return null;

  return { grapheme, samples };
}

export function readSkillState(raw: unknown): SkillState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as { slug?: unknown; skills?: unknown };
  if (!isSlug(c.slug)) return null;
  if (!Array.isArray(c.skills)) return null;

  // Folded through mergeSkills so two entries that case-fold to the same
  // grapheme combine rather than one silently winning.
  const skills = c.skills.map(readSkill).filter((s): s is Skill => s !== null);
  return mergeSkills({ slug: c.slug, skills: [] }, { slug: c.slug, skills });
}

/* ── streaks ────────────────────────────────────────────────────────────── */

/**
 * Practice days, per learner and **not** per language.
 *
 * A practice day is a fact about a person, so a learner who does French on
 * Monday and Hindi on Tuesday has practised two days running rather than
 * started two streaks.
 *
 * Note what is absent: `current`. The current run depends on what day it is
 * *for the learner*, and the server does not know their timezone — a request
 * arriving at 23:40 in Auckland and one at 23:40 in Lisbon look identical
 * here. So the server keeps the days and the record; the client derives the
 * live streak against its own clock. Computing `current` here would produce a
 * number that is wrong for most of the world for part of every day.
 */
export interface StreakState {
  /** `YYYY-MM-DD` in the learner's own timezone, sorted, unique. */
  days: string[];
  /** The best run ever recorded, which a lapse must not erase. */
  longest: number;
}

/** Matches the client's cap: enough for a two-month calendar, bounded. */
const MAX_DAYS = 60;

/** `YYYY-MM-DD`, and a real date rather than 2026-99-99. */
function isDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  // Round-trips only if the date exists — 2026-02-30 parses to 2 March.
  return parsed.toISOString().slice(0, 10) === value;
}

function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00.000Z`).getTime();
  const b = new Date(`${to}T00:00:00.000Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

/** The longest consecutive run in a sorted, unique list of days. */
export function longestRun(days: string[]): number {
  let best = 0;
  let run = 0;
  for (let i = 0; i < days.length; i += 1) {
    const current = days[i];
    const previous = i > 0 ? days[i - 1] : undefined;
    if (current === undefined) continue;
    run = previous !== undefined && daysBetween(previous, current) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}

/**
 * Combines two devices' practice records.
 *
 * A **set union** of days, and this is the one merge rule that must not be got
 * wrong. Under last-write-wins a phone that synced yesterday would overwrite a
 * tablet that practised today, deleting a real practice day — the most
 * damaging thing a streak can do, and completely silent: the learner just
 * finds their streak shorter than they know it to be, with no way to argue.
 *
 * It is also why `days` is a list of dates rather than a count. A count cannot
 * be merged, only clobbered.
 *
 * `longest` is the larger of both sides' records *and* whatever the merged
 * days actually show, because a run that has since aged out of the capped list
 * was still real, and neither device may be the one that remembers it.
 */
export function mergeStreaks(mine: StreakState, theirs: StreakState): StreakState {
  const union = [...new Set([...mine.days, ...theirs.days])].sort();
  // Trimmed after the union, so the cap never decides which device's days
  // survive — only how far back the record goes.
  const days = union.slice(-MAX_DAYS);

  return {
    days,
    // Computed over the untrimmed union: trimming must not shorten a record.
    longest: Math.max(mine.longest, theirs.longest, longestRun(union)),
  };
}

export function readStreakState(raw: unknown): StreakState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as { days?: unknown; longest?: unknown };
  if (!Array.isArray(c.days)) return null;

  const days = [...new Set(c.days.filter(isDay))].sort().slice(-MAX_DAYS);
  const longest =
    typeof c.longest === "number" && Number.isFinite(c.longest) && c.longest >= 0
      ? Math.min(100_000, Math.floor(c.longest))
      : 0;

  // Never trusted above what the days can justify plus what was already
  // recorded — a client claiming a longest of 900 with three days stored is
  // either broken or hand-edited.
  return { days, longest: Math.max(longest, longestRun(days)) };
}
