/**
 * The journey: units, the lessons under them, and the evidence behind every
 * can-do statement. Pure, no React, no I/O, no clock read.
 *
 * ## The rule the whole file exists to keep
 *
 * A can-do statement — "You can order food and be understood" — is a claim
 * about a person, made by software that measured them. It may be shown as
 * *earned* only when there is evidence for it, and the evidence has to be the
 * thing that decides rather than a caption underneath a decision made some
 * other way. So `outcomeEarned` is computed from two facts a learner can check
 * on the same screen: every lesson in the unit finished, **and** the sounds it
 * drills holding at rung 3 or better on the review ladder.
 *
 * Lessons alone are not enough, and that is the interesting half. A learner can
 * finish every activity in a unit by exhausting their tries — the gate is soft
 * by design, because a hard one traps somebody on a sound they cannot yet make
 * — so "did all the lessons" is closer to attendance than to ability. Rung 3
 * means a sound has held up across a week or more of spaced reviews, which is
 * the closest thing this product has to evidence that something stuck.
 *
 * ## No padlocks
 *
 * `state` distinguishes done, current and open. It does **not** distinguish
 * *locked*, because nothing is: a learner may open any unit in any order. The
 * line through the journey shows what follows what, not what they are allowed
 * to do. Anything reading this module for a reason to disable a control is
 * reading it wrong.
 */

import type { Activity, ActivityProgress, LanguageActivitySet } from "../activities/types.js";
import type { SkillStore } from "../stores/skillStore.js";
import { stepFor } from "./soundReview.js";

/**
 * The rung a sound has to reach before it counts toward an outcome.
 *
 * Index 2 of the ladder — a third review, which lands roughly a week out. One
 * good take is a good take; holding through two spaced reviews is the earliest
 * point at which "you can do this" is a claim about the learner rather than
 * about one recording.
 */
export const HOLDING_RUNG = 2;

export type ItemState = "done" | "current" | "open";

export interface JourneyLesson {
  id: number;
  title: string;
  outcome: string;
  state: ItemState;
  /** Activities passed, of the lesson's total. */
  done: number;
  total: number;
}

export interface JourneyUnit {
  id: number;
  title: string;
  outcome: string;
  state: ItemState;
  lessons: JourneyLesson[];
  lessonsDone: number;
  lessonsTotal: number;
  /**
   * Sounds this unit drills that are holding at `HOLDING_RUNG` or better.
   * Shown as the receipt, so a learner can see what the claim rests on.
   */
  holdingSounds: string[];
  /** Every sound the unit's activities name, holding or not. */
  touchedSounds: string[];
  /** ISO timestamp of the most recent attempt in this unit, or null. */
  lastPractisedAt: string | null;
  /**
   * Whether the can-do statement may be shown as earned.
   *
   * Never true on lessons alone — see the file comment. A unit whose lessons
   * are finished but whose sounds have not held reads as *done* in the rail and
   * still does not claim the outcome, which is the distinction the screen has
   * to render rather than smooth over.
   */
  outcomeEarned: boolean;
}

export interface Journey {
  slug: string;
  label: string;
  code: string;
  units: JourneyUnit[];
  /** True when the set has no spine — every screen must handle this shape. */
  flat: boolean;
}

function passedIds(progress: ActivityProgress[]): Set<number> {
  return new Set(progress.filter((entry) => entry.passed).map((entry) => entry.activityId));
}

/** The latest attempt across a set of activities, or null if none was made. */
function lastAttempt(progress: ActivityProgress[], ids: Set<number>): string | null {
  let latest: string | null = null;
  for (const entry of progress) {
    if (!ids.has(entry.activityId)) continue;
    for (const attempt of entry.attempts) {
      if (latest === null || attempt.at > latest) latest = attempt.at;
    }
  }
  return latest;
}

/**
 * The journey for one language.
 *
 * A set with no spine yields `flat: true` and no units rather than a fabricated
 * single unit wrapping everything. A fabricated one would have to invent a
 * can-do statement, and an outcome nobody wrote is exactly the kind of claim
 * this module exists to prevent.
 */
export function journeyFor(
  content: LanguageActivitySet,
  progress: ActivityProgress[],
  skills: SkillStore,
): Journey {
  const base = { slug: content.slug, label: content.label, code: content.code };

  if (content.units === undefined || content.units.length === 0) {
    return { ...base, units: [], flat: true };
  }

  const byId = new Map<number, Activity>(content.activities.map((a) => [a.id, a]));
  const passed = passedIds(progress);

  /**
   * Which sounds have held, computed once. `stepFor` replays a sound's whole
   * history, so asking it per unit per render would repeat that work for every
   * unit naming the same grapheme — and most units do.
   */
  const holding = new Set(
    Object.values(skills)
      .filter((skill) => stepFor(skill.samples) >= HOLDING_RUNG)
      .map((skill) => skill.grapheme),
  );

  let seenCurrent = false;

  const units = content.units.map((unit): JourneyUnit => {
    const unitActivityIds = new Set(unit.lessons.flatMap((lesson) => lesson.activityIds));

    const touched = new Set<string>();
    for (const id of unitActivityIds) {
      for (const sound of byId.get(id)?.soundTargets ?? []) touched.add(sound);
    }

    const lessons = unit.lessons.map((lesson): JourneyLesson => {
      const total = lesson.activityIds.length;
      const done = lesson.activityIds.filter((id) => passed.has(id)).length;

      /**
       * "Current" is the first unfinished thing, and exactly one of them gets
       * it. Marking every unfinished lesson as current would tell a learner
       * they are in four places at once; marking none would leave the rail
       * with no answer to "where was I", which is the question it exists for.
       */
      let state: ItemState = "open";
      if (total > 0 && done === total) {
        state = "done";
      } else if (!seenCurrent) {
        state = "current";
        seenCurrent = true;
      }

      return { id: lesson.id, title: lesson.title, outcome: lesson.outcome, state, done, total };
    });

    const lessonsTotal = lessons.length;
    const lessonsDone = lessons.filter((lesson) => lesson.state === "done").length;

    const holdingSounds = [...touched].filter((sound) => holding.has(sound)).sort();
    const allLessonsDone = lessonsTotal > 0 && lessonsDone === lessonsTotal;

    /**
     * Every sound the unit names has to hold, not merely some of them. A unit
     * that claims "you can order food and be understood" while one of its
     * sounds is still at rung 0 is claiming something the evidence contradicts,
     * and a majority rule would let the hardest sound — which is the one the
     * learner actually needs — be the one that never counts.
     *
     * `touched.size === 0` means the content names no sounds at all, which is
     * a set published before the mapping existed. No evidence is available, so
     * the outcome is not claimed. That is stricter than the alternative and
     * deliberately so: silence about an outcome is recoverable, a false claim
     * about a learner's ability is not.
     */
    const soundsHold = touched.size > 0 && holdingSounds.length === touched.size;

    return {
      id: unit.id,
      title: unit.title,
      outcome: unit.outcome,
      state: allLessonsDone ? "done" : lessons.some((l) => l.state === "current") ? "current" : "open",
      lessons,
      lessonsDone,
      lessonsTotal,
      holdingSounds,
      touchedSounds: [...touched].sort(),
      lastPractisedAt: lastAttempt(progress, unitActivityIds),
      outcomeEarned: allLessonsDone && soundsHold,
    };
  });

  return { ...base, units, flat: false };
}
