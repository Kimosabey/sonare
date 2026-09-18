/**
 * N4 and N5 — two promises the product makes, swept rather than sampled.
 *
 * **N4, outcome honesty.** No can-do statement renders as met without its
 * evidence. A claim about what a person can do, made by software that measured
 * them, is the single most damaging thing this product could get wrong: a
 * learner told they can order food who then cannot is worse off than one told
 * nothing.
 *
 * **N5, the listening activity costs no permission.** It makes no scorer call
 * and needs no microphone. On iOS a learner may only ever be asked for the
 * microphone once, so an activity that triggers the prompt without needing it
 * spends something that cannot be got back from the page.
 *
 * Both are asserted against the functions that decide, over generated states,
 * because both are properties of every case rather than of an example.
 */

import { describe, expect, it } from "vitest";
import { journeyFor, HOLDING_RUNG } from "./journey.js";
import { affordancesFor } from "./affordances.js";
import { stepFor } from "./soundReview.js";
import { ACTIVITY_KINDS, type Activity, type ActivityProgress, type LanguageActivitySet } from "../activities/types.js";
import type { SkillStore } from "../stores/skillStore.js";

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const SOUNDS = ["bon", "jour", "soir", "mer"];

function generateCourse(next: () => number): LanguageActivitySet {
  const activities: Activity[] = Array.from({ length: 9 }, (_, i) => ({
    id: i + 1,
    title: `Activity ${String(i + 1)}`,
    kind: "repeat",
    prompt: "Say it",
    gloss: "gloss",
    target: `Phrase ${String(i + 1)}`,
    focus: "focus",
    // Sometimes no mapping at all, which is a set published before the field.
    ...(next() < 0.85
      ? { soundTargets: [SOUNDS[Math.floor(next() * SOUNDS.length)] ?? "bon"] }
      : {}),
  }));

  return {
    code: "fr-FR",
    slug: "fr",
    label: "French",
    activities,
    units: [
      {
        id: 1,
        title: "Unit",
        outcome: "You can order food and be understood.",
        lessons: [
          { id: 1, title: "A", outcome: "a", activityIds: [1, 2, 3] },
          { id: 2, title: "B", outcome: "b", activityIds: [4, 5, 6] },
          { id: 3, title: "C", outcome: "c", activityIds: [7, 8, 9] },
        ],
      },
    ],
  };
}

/**
 * Progress, biased so the sweep reaches both answers.
 *
 * Uniform randomness does not: earning an outcome needs all nine activities
 * passed *and* every sound it names holding, which is under one case in two
 * hundred. The first version of this file generated three hundred cases and
 * **never earned one** — the guard below caught it, and without that guard the
 * three "never claims falsely" tests would have passed by never claiming
 * anything at all.
 *
 * So a third of cases are generated as a finished course. That is not a
 * convenience: a property test that cannot reach the positive branch is only
 * testing that the negative one exists.
 */
function generateProgress(
  next: () => number,
  content: LanguageActivitySet,
  complete = false,
): ActivityProgress[] {
  return content.activities
    .filter(() => complete || next() < 0.8)
    .map((a) => ({
      activityId: a.id,
      attempts: [],
      best: 80,
      passed: complete || next() < 0.7,
      skipped: false,
    }));
}

function generateSkills(next: () => number, strong = false): SkillStore {
  const store: SkillStore = {};
  for (const grapheme of SOUNDS) {
    if (!strong && next() < 0.25) continue;
    const count = strong ? 4 + Math.floor(next() * 5) : 1 + Math.floor(next() * 8);
    store[grapheme] = {
      grapheme,
      samples: Array.from({ length: count }, (_, i) => ({
        at: new Date(Date.UTC(2026, 0, 1 + i * 2, 9)).toISOString(),
        accuracy: strong || next() < 0.5 ? 85 + Math.floor(next() * 15) : Math.floor(next() * 60),
      })),
    };
  }
  return store;
}

/**
 * One generated case, from three shapes — and the third is the one that
 * matters.
 *
 * `lessonsOnly` finishes every activity while leaving the sounds weak. That is
 * precisely the case N4 exists for: the gate is soft, so a learner can pass
 * every activity by exhausting their tries, and "did all the lessons" is closer
 * to attendance than ability.
 *
 * It was missing from the first version of this generator, and the omission was
 * invisible until the rule was mutated: dropping the sound check from
 * `outcomeEarned` left every test here green, because no generated case had
 * finished lessons *without* strong sounds for it to wrongly claim. A sweep
 * that cannot construct the failure is not testing for it.
 */
function generateCase(seed: number): {
  content: LanguageActivitySet;
  progress: ActivityProgress[];
  skills: SkillStore;
} {
  const next = rng(seed + 1);
  const roll = next();
  const complete = roll < 0.3;
  const lessonsOnly = !complete && roll < 0.6;
  const content = generateCourse(next);

  return {
    content,
    progress: generateProgress(next, content, complete || lessonsOnly),
    skills: lessonsOnly ? weakSkills() : generateSkills(next, complete),
  };
}

/** Every sound present and none of them holding — one weak take each. */
function weakSkills(): SkillStore {
  const store: SkillStore = {};
  for (const grapheme of SOUNDS) {
    store[grapheme] = {
      grapheme,
      samples: [{ at: "2026-01-01T09:00:00.000Z", accuracy: 30 }],
    };
  }
  return store;
}

const CASES = 300;

describe("N4 — no can-do statement without its evidence", () => {
  /**
   * The sweep has to actually reach both answers, or "never claims falsely"
   * would pass on a run where nothing was ever claimed at all.
   */
  it("reaches both earned and unearned outcomes, so the checks below mean something", () => {
    let earned = 0;
    let unearned = 0;

    for (let seed = 0; seed < CASES; seed += 1) {
      const { content, progress, skills } = generateCase(seed);
      const journey = journeyFor(content, progress, skills);
      for (const unit of journey.units) {
        if (unit.outcomeEarned) earned += 1;
        else unearned += 1;
      }
    }

    expect(earned).toBeGreaterThan(0);
    expect(unearned).toBeGreaterThan(0);
  });

  /**
   * And the sweep reaches the specific failure N4 is about: every lesson
   * finished, the sounds not holding, the outcome withheld. Without cases of
   * this shape the rule can be deleted and every test here stays green — which
   * is exactly what happened before `lessonsOnly` was added.
   */
  it("reaches units with every lesson done and the outcome still withheld", () => {
    let lessonsDoneButUnearned = 0;

    for (let seed = 0; seed < CASES; seed += 1) {
      const { content, progress, skills } = generateCase(seed);
      for (const unit of journeyFor(content, progress, skills).units) {
        if (unit.lessonsDone === unit.lessonsTotal && !unit.outcomeEarned) {
          lessonsDoneButUnearned += 1;
        }
      }
    }

    expect(lessonsDoneButUnearned).toBeGreaterThan(0);
  });

  it("claims an outcome only when every lesson is done", () => {
    for (let seed = 0; seed < CASES; seed += 1) {
      const { content, progress, skills } = generateCase(seed);
      const journey = journeyFor(content, progress, skills);

      for (const unit of journey.units) {
        if (!unit.outcomeEarned) continue;
        expect(unit.lessonsDone, `seed ${seed}`).toBe(unit.lessonsTotal);
      }
    }
  });

  it("claims an outcome only when every sound it names is holding", () => {
    for (let seed = 0; seed < CASES; seed += 1) {
      const { content, progress, skills } = generateCase(seed);
      const journey = journeyFor(content, progress, skills);

      for (const unit of journey.units) {
        if (!unit.outcomeEarned) continue;

        expect(unit.touchedSounds.length, `seed ${seed}`).toBeGreaterThan(0);
        expect(unit.holdingSounds, `seed ${seed}`).toEqual(unit.touchedSounds);

        // And the rung is real, read back from the history rather than trusted.
        for (const sound of unit.holdingSounds) {
          const skill = skills[sound];
          expect(skill, `seed ${seed}, ${sound}`).toBeDefined();
          if (skill) expect(stepFor(skill.samples), `seed ${seed}, ${sound}`).toBeGreaterThanOrEqual(HOLDING_RUNG);
        }
      }
    }
  });

  /**
   * The receipts must be exactly what was checked. A screen showing evidence
   * that did not decide would be a caption, and a learner checking it on
   * Progress would find it did not add up.
   */
  it("shows only sounds it actually verified", () => {
    for (let seed = 0; seed < CASES; seed += 1) {
      const { content, progress, skills } = generateCase(seed);
      const journey = journeyFor(content, progress, skills);

      for (const unit of journey.units) {
        for (const sound of unit.holdingSounds) {
          expect(unit.touchedSounds, `seed ${seed}`).toContain(sound);
          const skill = skills[sound];
          if (skill) expect(stepFor(skill.samples)).toBeGreaterThanOrEqual(HOLDING_RUNG);
        }
      }
    }
  });
});

describe("N5 — a listening activity costs no permission", () => {
  /**
   * The decision, at the level it is made. On iOS a learner may only ever be
   * asked for the microphone once, so an activity that triggers the prompt
   * without needing it spends something the page cannot get back.
   */
  it("needs no microphone, in any state it can be in", () => {
    for (const takes of [0, 1, 3, 10]) {
      for (const revealed of [false, true]) {
        expect(affordancesFor("listen", { takes, revealed }).needsMicrophone).toBe(false);
      }
    }
  });

  /**
   * Two kinds now, and naming both is the point rather than a loosening.
   *
   * `locate` joined `listen` in asking nothing of the microphone, and the rule
   * this file protects is not "exactly one kind is silent" — it is that a kind
   * needing no microphone must never trigger the prompt, because on iOS a
   * learner may only ever be asked once. Written as a list, a third kind has
   * to come past this line and say why.
   */
  const SILENT_KINDS = ["listen", "locate"];

  it("is one of exactly the kinds that ask nothing of the microphone", () => {
    for (const kind of ACTIVITY_KINDS) {
      const needs = affordancesFor(kind, { takes: 0, revealed: false }).needsMicrophone;
      expect(needs, kind).toBe(!SILENT_KINDS.includes(kind));
    }
  });

  /**
   * And the silent ones stay silent in every state. A kind that reached the
   * recorder after a reveal or a retake would spend the one prompt iOS gives,
   * by a route nothing on the screen suggests.
   */
  it.each(["listen", "locate"] as const)(
    "%s needs no microphone in any state it can be in",
    (kind) => {
      for (const takes of [0, 1, 3, 10]) {
        for (const revealed of [false, true]) {
          expect(affordancesFor(kind, { takes, revealed }).needsMicrophone).toBe(false);
          expect(affordancesFor(kind, { takes, revealed }).canReveal).toBe(false);
        }
      }
    },
  );

  /**
   * And it has nothing to reveal and nothing to hear itself back on, so no
   * path through it reaches the recorder by another route.
   */
  it("offers no reveal and no retake to reach a microphone through", () => {
    const listen = affordancesFor("listen", { takes: 0, revealed: false });

    expect(listen.canReveal).toBe(false);
    expect(listen.attemptLimit).toBe(1);
  });
});
