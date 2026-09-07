/**
 * What to practise next. Pure, no I/O.
 *
 * Spaced repetition scheduled over **syllables rather than cards**, because a
 * syllable is what this system actually measures and because you cannot
 * practise a phoneme in isolation. So the scheduler ranks sounds, and then
 * picks the phrase that drills the most due, weakest sounds at once. That
 * inversion is what makes spaced repetition fit pronunciation instead of
 * vocabulary.
 *
 * It needs no new data. `skills` already stores up to twenty timestamped
 * accuracies per written syllable, so a first run derives its schedule from
 * history rather than starting cold.
 *
 * ## The line this must not cross
 *
 * The scheduler decides **what to practise next**. It must never decide
 * **whether the learner succeeded** — that number comes from the provider's
 * assessment or it is not shown at all (R3) — and it must never feed the
 * streak, which counts attendance and takes no score.
 *
 * Concretely: a sound dropping back to the first interval is a scheduling
 * decision, not a verdict. It changes what appears tomorrow. It does not
 * change today's score, does not consume an attempt, and cannot break a
 * streak. Nothing here returns a pass, a fail, or a band.
 */

import type { Skill, SkillSample } from "./merge.js";

/**
 * Days between reviews, expanding as a sound holds up.
 *
 * Roughly doubling, which is the shape every spaced-repetition system
 * converges on. It stops at thirty-five days rather than growing forever
 * because a pronunciation habit is motor memory that decays with disuse, and
 * because a learner who sees a sound once a year has effectively stopped
 * practising it — there is no value in an interval longer than the gap that
 * would make them a beginner again.
 */
export const LADDER = [1, 3, 7, 16, 35] as const;

/**
 * Where a sound has to reach to earn a longer interval, and where it falls
 * back to the beginning.
 *
 * These match today's display bands (band.ts: ≥80, ≥60) and that is not a
 * coincidence — they encode the same judgement about what "said well" means.
 * They are nonetheless separate constants, deliberately, because the display
 * band is about colour and this is about curriculum. Sharing them would mean
 * that restyling a chip silently rescheduled every learner's practice.
 */
const STRONG = 80;
const WEAK = 60;

/**
 * How much the most recent samples outweigh the oldest.
 *
 * A sound fixed last week is fixed, and a flat mean would keep punishing a
 * learner for takes from before they learned it — the exact opposite of what a
 * progress figure is for. Linear rather than exponential so that a single good
 * take cannot declare a long-standing problem solved.
 */
const RECENCY_WEIGHT = 3;

/** Below this there is no pattern, only noise. Matches report.ts. */
const MIN_SAMPLES = 2;

export interface SkillSchedule {
  grapheme: string;
  /** Recency-weighted mean accuracy, 0-100. Not a score, and not shown as one. */
  strength: number;
  samples: number;
  /** Index into LADDER. */
  step: number;
  /** `YYYY-MM-DD`, the day this sound is next worth practising. */
  due: string;
  /** True when `due` has arrived. */
  isDue: boolean;
}

function day(when: Date): string {
  return when.toISOString().slice(0, 10);
}

function addDays(when: Date, days: number): Date {
  return new Date(when.getTime() + days * 86_400_000);
}

/**
 * Recency-weighted mean of a sound's accuracies.
 *
 * Weights rise linearly from 1 to `RECENCY_WEIGHT` across the samples in
 * order, so the newest take counts three times the oldest. Returns 0 for no
 * samples, which callers must not treat as "said badly" — `samples` is the
 * field that distinguishes the two.
 */
export function strengthOf(samples: SkillSample[]): number {
  if (samples.length === 0) return 0;
  if (samples.length === 1) return samples[0]?.accuracy ?? 0;

  const ordered = [...samples].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  let weighted = 0;
  let total = 0;
  for (let i = 0; i < ordered.length; i += 1) {
    const sample = ordered[i];
    if (sample === undefined) continue;
    // 1 at the oldest, RECENCY_WEIGHT at the newest.
    const weight = 1 + (RECENCY_WEIGHT - 1) * (i / (ordered.length - 1));
    weighted += sample.accuracy * weight;
    total += weight;
  }

  return total === 0 ? 0 : Math.round((weighted / total) * 10) / 10;
}

/**
 * Which rung of the ladder a sound has climbed to.
 *
 * Replayed over the whole history rather than stored, so the schedule is
 * derived from the samples and cannot drift out of step with them — and so
 * this works on the history that already exists rather than needing a
 * migration to add a stored step.
 *
 * Each sample is judged on its own accuracy, not against the running strength.
 * That is deliberate: the rung records a *sequence of takes* holding up, so
 * reaching the top means five strong takes in a row without a weak one
 * resetting it. Judging against the accumulated mean instead would let a
 * strong history carry a weak take upward, which is the opposite of what an
 * interval is supposed to represent.
 */
export function stepFor(samples: SkillSample[]): number {
  const ordered = [...samples].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  let step = 0;
  for (let i = 0; i < ordered.length; i += 1) {
    const sample = ordered[i];
    if (sample === undefined) continue;

    if (sample.accuracy >= STRONG) {
      step = Math.min(step + 1, LADDER.length - 1);
    } else if (sample.accuracy < WEAK) {
      // All the way back, not one rung. A sound that has stopped working needs
      // practice tomorrow, and stepping down gently means a learner keeps
      // being shown a sound they cannot yet make at ever-longer intervals.
      step = 0;
    }
    // Between the two: hold. The sound is neither reliable nor lost.
  }

  return step;
}

/** The schedule for one sound. */
export function scheduleFor(skill: Skill, now: Date): SkillSchedule {
  const samples = skill.samples;
  const step = stepFor(samples);
  const interval = LADDER[step] ?? LADDER[0];

  const last = samples.reduce<string>((latest, s) => (s.at > latest ? s.at : latest), "");
  const lastDate = last === "" ? now : new Date(last);
  const dueDate = addDays(Number.isNaN(lastDate.getTime()) ? now : lastDate, interval);

  return {
    grapheme: skill.grapheme,
    strength: strengthOf(samples),
    samples: samples.length,
    step,
    due: day(dueDate),
    isDue: day(dueDate) <= day(now),
  };
}

/**
 * Every sound worth practising today, weakest first.
 *
 * Sounds with too little history are excluded rather than ranked. One bad take
 * is not a pattern, and sending a learner to drill something they fluffed once
 * would spend their session on the wrong thing — the same threshold report.ts
 * applies within a session, for the same reason.
 */
export function dueSounds(skills: Skill[], now: Date): SkillSchedule[] {
  return skills
    .map((skill) => scheduleFor(skill, now))
    .filter((schedule) => schedule.isDue && schedule.samples >= MIN_SAMPLES)
    .sort((a, b) => a.strength - b.strength || (a.grapheme < b.grapheme ? -1 : 1));
}

/**
 * An activity the scheduler can choose between.
 *
 * `graphemes` is the written syllables the activity exercises. Supplied by the
 * caller rather than derived here, because deriving it needs syllabification
 * of the reference text — which this system only ever gets from the provider,
 * at scoring time. In practice the mapping is learned: once a learner has
 * attempted an activity, its syllables are known. Until content carries them
 * (that work is separate), an unattempted activity has an empty list and is
 * chosen only as a fallback.
 */
export interface SchedulableActivity {
  id: number;
  graphemes: string[];
  /** True when the learner has already passed it. */
  passed: boolean;
  /** ISO timestamp of the last attempt, or null. */
  lastAttemptAt: string | null;
}

export interface Selection {
  activityId: number;
  /** The due sounds this activity covers, weakest first. */
  covers: string[];
  /**
   * Why it was chosen, so a screen can say something true rather than
   * "recommended for you".
   */
  reason: "due-sounds" | "unpractised" | "weakest-unpassed";
}

/**
 * The activity to offer, or null when there is nothing to choose from.
 *
 * Prefers the activity covering the most due sounds — that is the whole point
 * of scheduling over syllables rather than over activities. Ties break toward
 * the lower mean strength of what it covers, then toward the least recently
 * practised, so two equally useful activities alternate instead of one being
 * offered forever.
 *
 * Falls back, in order, to something never attempted and then to the weakest
 * unpassed activity. A learner with no due sounds has not run out of things to
 * do, and returning null there would be a blank screen for someone doing well.
 */
export function selectActivity(
  activities: SchedulableActivity[],
  due: SkillSchedule[],
): Selection | null {
  /**
   * Takes no clock. Everything time-dependent has already happened: `due` was
   * computed against a `now` by dueSounds, and the least-recently-practised
   * tie-break compares two timestamps with each other rather than with the
   * present. A `now` parameter here would claim a dependency that does not
   * exist, which is the kind of signature that gets a caller passing a stale
   * clock and wondering why nothing changed.
   */
  if (activities.length === 0) return null;

  const strengthByGrapheme = new Map(due.map((d) => [d.grapheme, d.strength]));
  const dueGraphemes = new Set(strengthByGrapheme.keys());

  let best: { activity: SchedulableActivity; covers: string[]; meanStrength: number } | null = null;

  for (const activity of activities) {
    const covers = activity.graphemes.filter((g) => dueGraphemes.has(g));
    if (covers.length === 0) continue;

    const meanStrength =
      covers.reduce((sum, g) => sum + (strengthByGrapheme.get(g) ?? 0), 0) / covers.length;

    if (
      best === null ||
      covers.length > best.covers.length ||
      (covers.length === best.covers.length &&
        (meanStrength < best.meanStrength ||
          (meanStrength === best.meanStrength &&
            olderAttempt(activity.lastAttemptAt, best.activity.lastAttemptAt))))
    ) {
      best = { activity, covers, meanStrength };
    }
  }

  if (best !== null) {
    return {
      activityId: best.activity.id,
      covers: [...best.covers].sort(
        (a, b) => (strengthByGrapheme.get(a) ?? 0) - (strengthByGrapheme.get(b) ?? 0),
      ),
      reason: "due-sounds",
    };
  }

  const unattempted = activities.find((a) => a.lastAttemptAt === null);
  if (unattempted !== undefined) {
    return { activityId: unattempted.id, covers: [], reason: "unpractised" };
  }

  // Everything has been attempted and nothing is due. Offer the oldest
  // unpassed activity, or the oldest of all if they have all been passed —
  // rather than a blank screen for a learner who is doing well.
  const pool = activities.filter((a) => !a.passed);
  const candidates = pool.length > 0 ? pool : activities;
  const oldest = candidates.reduce((a, b) => (olderAttempt(a.lastAttemptAt, b.lastAttemptAt) ? a : b));

  return { activityId: oldest.id, covers: [], reason: "weakest-unpassed" };
}

/** Whether `a` was attempted longer ago than `b`. Never-attempted is oldest. */
function olderAttempt(a: string | null, b: string | null): boolean {
  if (a === null) return true;
  if (b === null) return false;
  return a < b;
}
