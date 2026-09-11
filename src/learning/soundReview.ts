/**
 * When a sound is worth practising again. Pure, no I/O, no clock.
 *
 * The client half of the review schedule. `server/domain/scheduler.ts` already
 * does this — same ladder, same rungs, same recency weighting — and this is a
 * deliberate mirror of it rather than a second opinion.
 *
 * ## Why a mirror and not an import
 *
 * `src/` does not import from `server/` anywhere in this repository, and the
 * reason is not tidiness. `server/domain/scheduler.ts` is typechecked with
 * Node types and lives beside modules that pull in pino and the Mongo driver;
 * the day somebody adds a `logger` call to it — entirely reasonable on that
 * side of the line — a client that imported it would stop building, for a
 * reason nothing at the import site could explain. The repository already
 * mirrors `ACTIVITY_KINDS`, the lesson bounds and the sample cap across the
 * same boundary for the same reason, and says so where it does it.
 *
 * What makes a mirror safe is that drift fails loudly.
 * `server/domain/scheduler.contract.test.ts` imports both sides and asserts
 * they agree over a seeded sweep of generated histories, so changing one rung
 * in either file is a red test rather than two devices quietly disagreeing
 * about what is due.
 *
 * ## The line this must not cross
 *
 * The same line the server's copy states: this decides **what to practise
 * next**, never **whether the learner succeeded**. `strength` is a
 * recency-weighted mean of accuracies the provider already returned. It is not
 * a score, it is never shown as one, and a sound falling back to the first
 * rung is a scheduling decision rather than a verdict — it changes what
 * appears tomorrow and nothing about today.
 */

import type { Skill, SkillSample, SkillStore } from "../stores/skillStore.js";

/**
 * Days between reviews, expanding as a sound holds up.
 *
 * Mirrors `LADDER` in server/domain/scheduler.ts, which carries the reasoning:
 * roughly doubling, stopping at thirty-five days because a pronunciation habit
 * is motor memory and there is no value in an interval longer than the gap
 * that would make the learner a beginner again.
 */
export const REVIEW_LADDER = [1, 3, 7, 16, 35] as const;

/**
 * Where a sound earns a longer interval, and where it falls back to the start.
 *
 * Mirrors STRONG/WEAK on the server, which are themselves deliberately
 * separate from the display bands: restyling a chip must not reschedule
 * everybody's practice.
 */
const STRONG = 80;
const WEAK = 60;

/** How much the newest sample outweighs the oldest. Linear, not exponential. */
const RECENCY_WEIGHT = 3;

/** Below this there is no pattern, only noise. Matches report.ts and the server. */
export const MIN_REVIEW_SAMPLES = 2;

export interface SoundReview {
  /** The written syllable, folded to lower case — how the skills store keys. */
  grapheme: string;
  /** Recency-weighted mean accuracy, 0-100. Not a score, and not shown as one. */
  strength: number;
  samples: number;
  /** Index into REVIEW_LADDER. */
  step: number;
  /** `YYYY-MM-DD`, the day this sound is next worth practising. */
  due: string;
  /** True when `due` has arrived. */
  isDue: boolean;
}

/** UTC day. One clock for a whole composition, so two lists cannot disagree. */
function day(when: Date): string {
  return when.toISOString().slice(0, 10);
}

function addDays(when: Date, days: number): Date {
  return new Date(when.getTime() + days * 86_400_000);
}

/** Oldest first. Samples are a set keyed on `at`, so they arrive in any order. */
function inTimeOrder(samples: SkillSample[]): SkillSample[] {
  return [...samples].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/**
 * Recency-weighted mean of a sound's accuracies.
 *
 * Weights rise linearly from 1 to `RECENCY_WEIGHT` across the samples in time
 * order, so the newest take counts three times the oldest. Returns 0 for no
 * samples, which callers must not read as "said badly" — `samples` is the
 * field that tells the two apart.
 */
export function strengthOf(samples: SkillSample[]): number {
  if (samples.length === 0) return 0;
  if (samples.length === 1) return samples[0]?.accuracy ?? 0;

  const ordered = inTimeOrder(samples);

  let weighted = 0;
  let total = 0;
  for (let i = 0; i < ordered.length; i += 1) {
    const sample = ordered[i];
    if (sample === undefined) continue;
    const weight = 1 + (RECENCY_WEIGHT - 1) * (i / (ordered.length - 1));
    weighted += sample.accuracy * weight;
    total += weight;
  }

  return total === 0 ? 0 : Math.round((weighted / total) * 10) / 10;
}

/**
 * Which rung of the ladder a sound has climbed to.
 *
 * Replayed over the whole history rather than stored, so the schedule cannot
 * drift out of step with the samples it came from and so this works on the
 * history already on disk. Each sample is judged on its own accuracy rather
 * than against the running mean: the rung records a *sequence of takes*
 * holding up, and judging against the mean would let a strong history carry a
 * weak take upward.
 */
export function stepFor(samples: SkillSample[]): number {
  const ordered = inTimeOrder(samples);

  let step = 0;
  for (let i = 0; i < ordered.length; i += 1) {
    const sample = ordered[i];
    if (sample === undefined) continue;

    if (sample.accuracy >= STRONG) {
      step = Math.min(step + 1, REVIEW_LADDER.length - 1);
    } else if (sample.accuracy < WEAK) {
      // All the way back, not one rung. A sound that has stopped working needs
      // practice tomorrow.
      step = 0;
    }
    // Between the two: hold. Neither reliable nor lost.
  }

  return step;
}

/** The schedule for one sound. */
export function reviewFor(skill: Skill, today: Date): SoundReview {
  const samples = skill.samples;
  const step = stepFor(samples);
  const interval = REVIEW_LADDER[step] ?? REVIEW_LADDER[0];

  const last = samples.reduce<string>((latest, s) => (s.at > latest ? s.at : latest), "");
  const lastDate = last === "" ? today : new Date(last);
  const dueDate = addDays(Number.isNaN(lastDate.getTime()) ? today : lastDate, interval);

  return {
    grapheme: skill.grapheme,
    strength: strengthOf(samples),
    samples: samples.length,
    step,
    due: day(dueDate),
    isDue: day(dueDate) <= day(today),
  };
}

/**
 * Weakest first, then alphabetical.
 *
 * A total order, deliberately: a `SkillStore` is an object, so its keys arrive
 * in whatever order the JSON happened to be written in, and a sort that left
 * ties unresolved would hand two devices the same session in two different
 * orders.
 */
function weakestFirst(a: SoundReview, b: SoundReview): number {
  return a.strength - b.strength || (a.grapheme < b.grapheme ? -1 : a.grapheme > b.grapheme ? 1 : 0);
}

/**
 * Every sound the store knows about, weakest first.
 *
 * Keyed on the store's own key rather than on `Skill.grapheme`: the key is
 * what `recordSkills` folded to lower case and what everything else joins on,
 * and a document written by hand could carry a `grapheme` field that disagrees
 * with it.
 */
export function allReviews(skills: SkillStore, today: Date): SoundReview[] {
  return Object.entries(skills)
    .map(([key, skill]) =>
      reviewFor({ grapheme: key.trim().toLocaleLowerCase(), samples: skill.samples }, today),
    )
    .sort(weakestFirst);
}

/**
 * Every sound worth practising today, weakest first.
 *
 * Sounds with too little history are excluded rather than ranked. One bad take
 * is not a pattern, and sending a learner to drill something they fluffed once
 * spends their sitting on the wrong thing — the same threshold report.ts
 * applies within a session and the server applies across devices.
 */
export function dueReviews(skills: SkillStore, today: Date): SoundReview[] {
  return allReviews(skills, today).filter((r) => r.isDue && r.samples >= MIN_REVIEW_SAMPLES);
}
