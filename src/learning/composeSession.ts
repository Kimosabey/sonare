/**
 * Today's sitting: one lesson's worth of activities, plus the sounds that are
 * due. Pure — no I/O, no storage, no clock read.
 *
 * ## Why this is client-side, always
 *
 * Offline-first is the architecture here rather than a feature. A learner with
 * no network completes a session today and must keep being able to, so "the
 * server returns today's session" cannot be a *dependency*. Everything this
 * needs is already on the device: the content set (bundled, or cached from a
 * publish), the learner's own progress, and their own sound history.
 *
 * `today` is a parameter for the same reason `selectActivity` takes no clock:
 * a function that reads the clock cannot be swept over a year of days in a
 * test, and the two lists it returns could disagree about whether a sound is
 * due if the composition straddled midnight.
 *
 * ## One decision-maker, two qualities of input
 *
 * The server's `GET /next` also ranks sounds and picks an activity, and it is
 * better at it — it alone sees every device's history. It is nonetheless an
 * **input to this function**, never an alternative to it. Two implementations
 * of "what next" drift silently, and the learner finds out by seeing their
 * session change when they come online.
 *
 * So `refinement` adjusts the **order** of the sitting this function was going
 * to compose anyway. It cannot add an activity, cannot remove one, and cannot
 * change which sounds are due. Composing with it and without it differs only
 * in ordering — asserted in composeSession.contract.test.ts, which is the test
 * that makes the claim real rather than aspirational.
 *
 * Where the server's pick is not in today's sitting, the refinement is inert
 * and the local ordering stands. That is correct rather than a shortcoming:
 * the server does not know which lesson spine this client is reading (it may
 * be serving `fr:2` to a client still on the bundled flat set), so its answer
 * is a preference over sounds, not a claim about membership.
 *
 * ## Which sitting, and the shapes that must keep working
 *
 * - **`units` is optional.** A flat set with no spine is the shape that
 *   already shipped. Those are chunked into balanced windows instead, and a
 *   window claims no `outcome` — inventing a can-do statement for a
 *   synthesised lesson would be exactly the unevidenced promise C13 exists to
 *   prevent.
 * - **`soundTargets` is optional.** hi-IN returns no syllable graphemes at
 *   all, so a Hindi mapping could only be data that never matches. An
 *   activity with no targets is still schedulable; it simply keeps its
 *   authored position, which is the documented fallback.
 * - **The gate is soft.** An activity is finished when it is passed *or* the
 *   learner has spent three scored attempts on it. This never composes a
 *   sitting that cannot be finished.
 * - **Indeterminate takes do not count.** Finishedness comes from
 *   `canAdvanceFrom`, which counts scored attempts only (R8).
 */

import {
  MAX_LESSON_ACTIVITIES,
  type Activity,
  type ActivityProgress,
  type LanguageActivitySet,
} from "../activities/types.js";
import type { SkillStore } from "../stores/skillStore.js";
import { canAdvanceFrom } from "./session.js";
import { dueReviews, type SoundReview } from "./soundReview.js";

/**
 * How many due sounds a sitting reports.
 *
 * Mirrors `MAX_DUE` in server/routes/next.ts, for the reason stated there: a
 * learner cannot act on twenty at once, and a screen that lists them all turns
 * a next step into a report card. The full schedule is available to the
 * progress view via `allReviews`.
 */
export const MAX_SESSION_REVIEWS = 5;

/**
 * The server's answer, as an input.
 *
 * Shaped to what `GET /next` returns — `Selection` from
 * server/domain/scheduler.ts — because that is the whole point: the server's
 * output is fed in rather than reimplemented. `reason` is carried through so a
 * screen can say something true instead of "recommended for you".
 */
export interface SessionRefinement {
  activityId: number;
  reason: "due-sounds" | "unpractised" | "weakest-unpassed";
  /** The due sounds that activity covers, weakest first. */
  covers: string[];
}

/** The lesson a sitting came from, when the set has a spine. */
export interface ComposedLesson {
  unitId: number;
  unitTitle: string;
  /** The unit's can-do statement. */
  unitOutcome: string;
  id: number;
  title: string;
  /** The lesson's can-do statement, in the learner's words. */
  outcome: string;
}

/** Which activity is offered first, and on whose evidence. */
export interface SessionOpening {
  activityId: number;
  /**
   * `server` when the refinement named an activity in this sitting, `local`
   * when this device's own sound history chose it. Named rather than implied,
   * so a screen can be honest about what it knows.
   */
  from: "server" | "local";
  /** The due sounds the opening activity drills, weakest first. */
  covers: string[];
}

export interface ComposedSession {
  slug: string;
  /** BCP-47 tag, for tagging target-language text (WCAG 3.1.2). */
  code: string;
  label: string;
  /** `YYYY-MM-DD` this was composed for. The same day composes the same thing. */
  day: string;
  /**
   * The lesson, or null when the sitting is a window over a spineless set.
   * Null is a shape, not a failure: it means there is no authored outcome to
   * show, and none must be invented.
   */
  lesson: ComposedLesson | null;
  /** In the order to offer them. Empty only when the set has no activities. */
  activities: Activity[];
  /** Sounds due today, weakest first, capped at MAX_SESSION_REVIEWS. */
  reviews: SoundReview[];
  /** How membership was decided. `empty` means the set carries no activities. */
  source: "lesson" | "window" | "empty";
  opening: SessionOpening | null;
}

/**
 * What one activity's history says, reduced from however many entries claim it.
 *
 * A `Map` built from `progress` with last-write-wins would make this
 * order-dependent the moment two entries shared an `activityId` — which sync's
 * merge can produce and which no type forbids. So duplicates are folded:
 * finished if *any* entry says so, last practised at the *latest* timestamp
 * any of them carries. Both are order-independent, which is what the sweep
 * over shuffled inputs actually checks.
 */
interface ActivityHistory {
  finished: boolean;
  lastAttemptAt: string | null;
}

function historyByActivity(progress: ActivityProgress[]): Map<number, ActivityHistory> {
  const out = new Map<number, ActivityHistory>();

  for (const entry of progress) {
    const latest = entry.attempts.reduce<string | null>(
      (best, a) => (typeof a.at !== "string" ? best : best === null || a.at > best ? a.at : best),
      null,
    );
    const previous = out.get(entry.activityId);
    out.set(entry.activityId, {
      finished: (previous?.finished ?? false) || canAdvanceFrom(entry),
      lastAttemptAt:
        previous?.lastAttemptAt == null
          ? latest
          : latest === null || latest < previous.lastAttemptAt
            ? previous.lastAttemptAt
            : latest,
    });
  }

  return out;
}

/** One candidate sitting: the ids it offers, and the lesson it came from. */
interface Sitting {
  activityIds: number[];
  lesson: ComposedLesson | null;
}

/**
 * The sittings a set offers, in order.
 *
 * A spine is authoritative when it resolves to anything at all: the publish
 * gate requires it to be exhaustive and non-overlapping, so every activity is
 * in exactly one lesson. A spine that resolves to nothing — `units: []`, or
 * lessons naming only ids the set no longer carries — falls through to
 * windows, because a session that cannot be finished is worse than one with no
 * authored outcome to show.
 */
function sittingsOf(content: LanguageActivitySet, known: Set<number>): Sitting[] {
  const spined: Sitting[] = [];

  for (const unit of content.units ?? []) {
    for (const lesson of unit.lessons) {
      const activityIds = lesson.activityIds.filter((id) => known.has(id));
      if (activityIds.length === 0) continue;
      spined.push({
        activityIds,
        lesson: {
          unitId: unit.id,
          unitTitle: unit.title,
          unitOutcome: unit.outcome,
          id: lesson.id,
          title: lesson.title,
          outcome: lesson.outcome,
        },
      });
    }
  }

  if (spined.length > 0) return spined;

  return windowsOf(content.activities.map((a) => a.id));
}

/**
 * A spineless set, chunked into balanced windows.
 *
 * Balanced rather than greedy — `ceil(n / MAX)` windows sharing the remainder
 * — because slicing six at a time leaves a set of seven with a tail of one,
 * and a sitting of one is a drill with an end-of-lesson screen attached.
 * Splitting seven as 4+3 keeps every window inside the authored lesson bounds
 * whenever the set is big enough to have them.
 */
function windowsOf(ids: number[]): Sitting[] {
  if (ids.length === 0) return [];

  const count = Math.ceil(ids.length / MAX_LESSON_ACTIVITIES);
  const base = Math.floor(ids.length / count);
  const extra = ids.length % count;

  const out: Sitting[] = [];
  let at = 0;
  for (let i = 0; i < count; i += 1) {
    const size = base + (i < extra ? 1 : 0);
    out.push({ activityIds: ids.slice(at, at + size), lesson: null });
    at += size;
  }
  return out;
}

/**
 * How many of `due` a sitting's activities drill, and the oldest attempt in it.
 *
 * Used only to choose between sittings the learner has already finished. A
 * learner who has passed everything has not run out of things to do, and
 * sending them back to lesson one forever would be the blank screen of a
 * different kind.
 */
function coverageOf(
  sitting: Sitting,
  byId: Map<number, Activity>,
  dueGraphemes: Set<string>,
): number {
  const covered = new Set<string>();
  for (const id of sitting.activityIds) {
    for (const grapheme of targetsOf(byId.get(id))) {
      if (dueGraphemes.has(grapheme)) covered.add(grapheme);
    }
  }
  return covered.size;
}

/** The activity's sound targets, folded the way the skills store keys. */
function targetsOf(activity: Activity | undefined): string[] {
  return (activity?.soundTargets ?? []).map((g) => g.trim().toLocaleLowerCase());
}

/** The latest attempt anywhere in a sitting, or null when none was practised. */
function lastPractisedIn(sitting: Sitting, history: Map<number, ActivityHistory>): string | null {
  return sitting.activityIds.reduce<string | null>((latest, id) => {
    const at = history.get(id)?.lastAttemptAt ?? null;
    if (at === null) return latest;
    return latest === null || at > latest ? at : latest;
  }, null);
}

/**
 * Which sitting to offer.
 *
 * The first one with anything unfinished, which is what "next" means to a
 * learner working through a course. Only when everything is finished does this
 * rank: most due sounds covered, then least recently practised, then lowest
 * index — a total order, so the choice cannot depend on which order the
 * progress entries happened to arrive in.
 */
function chooseSitting(
  sittings: Sitting[],
  byId: Map<number, Activity>,
  history: Map<number, ActivityHistory>,
  dueGraphemes: Set<string>,
): Sitting | null {
  const unfinished = sittings.find((s) =>
    s.activityIds.some((id) => !(history.get(id)?.finished ?? false)),
  );
  if (unfinished !== undefined) return unfinished;
  if (sittings.length === 0) return null;

  let best: { sitting: Sitting; covers: number; last: string | null } | null = null;
  for (const sitting of sittings) {
    const covers = coverageOf(sitting, byId, dueGraphemes);
    const last = lastPractisedIn(sitting, history);
    if (
      best === null ||
      covers > best.covers ||
      (covers === best.covers && olderThan(last, best.last))
    ) {
      best = { sitting, covers, last };
    }
  }
  return best?.sitting ?? null;
}

/** Whether `a` was practised longer ago than `b`. Never-practised is oldest. */
function olderThan(a: string | null, b: string | null): boolean {
  if (a === null) return b !== null;
  if (b === null) return false;
  return a < b;
}

/**
 * Which of the sitting's activities to open with, from this device's history.
 *
 * The same judgement `selectActivity` makes — the activity drilling the most
 * due, weakest sounds at once — narrowed to a sitting whose membership is
 * already settled. It deliberately has none of that function's fallbacks:
 * "never attempted" and "weakest unpassed" answer *which activity to offer*,
 * and that question has already been answered here by the spine. This only
 * orders.
 *
 * Returns null when nothing in the sitting drills a due sound, which is the
 * common case for a set with no `soundTargets` at all. Authored order then
 * stands, and that is the documented fallback rather than a gap.
 */
function localOpening(
  activities: Activity[],
  due: SoundReview[],
): { activityId: number; covers: string[] } | null {
  if (due.length === 0) return null;

  const strengthByGrapheme = new Map(due.map((r) => [r.grapheme, r.strength]));

  let best: { activityId: number; covers: string[]; meanStrength: number } | null = null;
  for (const activity of activities) {
    const covers = targetsOf(activity).filter((g) => strengthByGrapheme.has(g));
    if (covers.length === 0) continue;

    const meanStrength =
      covers.reduce((sum, g) => sum + (strengthByGrapheme.get(g) ?? 0), 0) / covers.length;

    if (
      best === null ||
      covers.length > best.covers.length ||
      (covers.length === best.covers.length &&
        (meanStrength < best.meanStrength ||
          // Lowest id last, so the choice is total rather than
          // first-one-encountered — which would depend on array order.
          (meanStrength === best.meanStrength && activity.id < best.activityId)))
    ) {
      best = { activityId: activity.id, covers, meanStrength };
    }
  }

  if (best === null) return null;
  return {
    activityId: best.activityId,
    covers: sortCovers(best.covers, strengthByGrapheme),
  };
}

/** Weakest first, then alphabetical — a total order over the covered sounds. */
function sortCovers(covers: string[], strengthByGrapheme: Map<string, number>): string[] {
  return [...new Set(covers)].sort(
    (a, b) =>
      (strengthByGrapheme.get(a) ?? 0) - (strengthByGrapheme.get(b) ?? 0) ||
      (a < b ? -1 : a > b ? 1 : 0),
  );
}

/**
 * Today's sitting.
 *
 * `refinement` is the server's answer when one arrived, and null or absent
 * otherwise — which is the offline case and the first-run case, and neither is
 * degraded: the membership of the sitting is identical either way.
 */
export function composeSession(
  content: LanguageActivitySet,
  progress: ActivityProgress[],
  skills: SkillStore,
  today: Date,
  refinement: SessionRefinement | null = null,
): ComposedSession {
  const day = today.toISOString().slice(0, 10);
  const reviews = dueReviews(skills, today).slice(0, MAX_SESSION_REVIEWS);

  const byId = new Map(content.activities.map((a) => [a.id, a]));
  const history = historyByActivity(progress);
  const dueGraphemes = new Set(reviews.map((r) => r.grapheme));

  const sittings = sittingsOf(content, new Set(byId.keys()));
  const chosen = chooseSitting(sittings, byId, history, dueGraphemes);

  if (chosen === null) {
    return {
      slug: content.slug,
      code: content.code,
      label: content.label,
      day,
      lesson: null,
      activities: [],
      reviews,
      source: "empty",
      opening: null,
    };
  }

  const authored = chosen.activityIds
    .map((id) => byId.get(id))
    .filter((a): a is Activity => a !== undefined);

  const opening = openingFor(authored, reviews, refinement);
  const activities =
    opening === null
      ? authored
      : [
          ...authored.filter((a) => a.id === opening.activityId),
          ...authored.filter((a) => a.id !== opening.activityId),
        ];

  return {
    slug: content.slug,
    code: content.code,
    label: content.label,
    day,
    lesson: chosen.lesson,
    activities,
    reviews,
    source: chosen.lesson === null ? "window" : "lesson",
    opening,
  };
}

/**
 * The opening activity — the one decision the server's input changes.
 *
 * The server wins when it named something in this sitting, because it is the
 * only party that has seen every device. Its `covers` is carried through
 * unchanged rather than recomputed: recomputing it locally would report the
 * sounds *this* device thinks are weak while claiming the server's reason,
 * which is the quiet kind of wrong.
 */
function openingFor(
  activities: Activity[],
  reviews: SoundReview[],
  refinement: SessionRefinement | null,
): SessionOpening | null {
  if (refinement !== null && activities.some((a) => a.id === refinement.activityId)) {
    return { activityId: refinement.activityId, from: "server", covers: [...refinement.covers] };
  }

  const local = localOpening(activities, reviews);
  if (local === null) return null;
  return { activityId: local.activityId, from: "local", covers: local.covers };
}
