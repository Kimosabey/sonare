/**
 * N2 and N3 — the two properties a spaced-repetition course lives or dies on,
 * swept over generated states rather than asserted on examples.
 *
 * **N2, the blend.** A sitting mixes new content with sounds the ladder has
 * brought round. Two things must hold however that mix falls out: no activity
 * appears twice, and the same day with the same state composes the same
 * sitting. A duplicate is a learner asked to say a phrase they just said; a
 * sitting that changes between renders is one that changes under their finger.
 *
 * **N3, commutativity — the critical one.** The merge layer is proved
 * commutative elsewhere, and this is the question one level up: does the
 * *estimate* depend on the order results arrived in? It must not. Two devices
 * sync in whatever order the network allows, so an order-dependent strength is
 * one where the same learner has two different histories depending on which
 * phone reconnected first.
 *
 * Generated rather than enumerated, because the interesting states are the
 * ones nobody thinks to write down: a sound at rung 0 with nine takes, a
 * lesson half-passed and half-skipped, a day that straddles a review's due
 * date.
 */

import { describe, expect, it } from "vitest";
import { composeSession } from "./composeSession.js";
import { strengthOf, stepFor, allReviews } from "./soundReview.js";
import type { Activity, ActivityProgress, LanguageActivitySet } from "../activities/types.js";
import type { Skill, SkillStore } from "../stores/skillStore.js";

/** Deterministic, so a failure names a seed somebody can re-run. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const SOUNDS = ["bon", "jour", "soir", "mer", "ci", "vous", "nuit", "ui"];

function activity(id: number, sounds: string[]): Activity {
  return {
    id,
    title: `Activity ${String(id)}`,
    kind: "repeat",
    prompt: "Say it",
    gloss: "gloss",
    target: `Phrase ${String(id)}`,
    focus: "focus",
    soundTargets: sounds,
  };
}

/** A course of random shape: 6-18 activities, sometimes with a spine. */
function generateContent(next: () => number): LanguageActivitySet {
  const count = 6 + Math.floor(next() * 13);
  const activities = Array.from({ length: count }, (_, i) =>
    activity(i + 1, [SOUNDS[Math.floor(next() * SOUNDS.length)] ?? "bon"]),
  );

  const set: LanguageActivitySet = { code: "fr-FR", slug: "fr", label: "French", activities };
  if (next() < 0.5) return set;

  const lessons = [];
  for (let i = 0; i + 3 <= count; i += 3) {
    lessons.push({
      id: lessons.length + 1,
      title: `Lesson ${String(lessons.length + 1)}`,
      outcome: "You can do the thing.",
      activityIds: activities.slice(i, i + 3).map((a) => a.id),
    });
    if (lessons.length >= 4) break;
  }
  if (lessons.length === 0) return set;

  return {
    ...set,
    units: [{ id: 1, title: "Unit", outcome: "You can be understood.", lessons }],
  };
}

function generateProgress(next: () => number, content: LanguageActivitySet): ActivityProgress[] {
  return content.activities
    .filter(() => next() < 0.6)
    .map((a) => {
      const passed = next() < 0.5;
      return {
        activityId: a.id,
        attempts: [],
        best: passed ? 80 + Math.floor(next() * 20) : Math.floor(next() * 60),
        passed,
        skipped: !passed && next() < 0.3,
      };
    });
}

/** Samples with distinct timestamps, so none collapses into another. */
function generateSamples(next: () => number, count: number): Skill["samples"] {
  return Array.from({ length: count }, (_, i) => ({
    at: new Date(Date.UTC(2026, 0, 1 + i * 2, 9)).toISOString(),
    accuracy: Math.floor(next() * 101),
  }));
}

function generateSkills(next: () => number): SkillStore {
  const store: SkillStore = {};
  for (const grapheme of SOUNDS) {
    if (next() < 0.4) continue;
    store[grapheme] = { grapheme, samples: generateSamples(next, 1 + Math.floor(next() * 9)) };
  }
  return store;
}

function shuffled<T>(items: T[], next: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

const CASES = 200;
const DAY = new Date("2026-09-15T09:00:00.000Z");

describe("N2 — the blend", () => {
  it("never offers the same activity twice in one sitting", () => {
    for (let seed = 0; seed < CASES; seed += 1) {
      const next = rng(seed + 1);
      const content = generateContent(next);
      const session = composeSession(
        content,
        generateProgress(next, content),
        generateSkills(next),
        DAY,
      );

      const ids = session.activities.map((a) => a.id);
      expect(new Set(ids).size, `seed ${seed}`).toBe(ids.length);
    }
  });

  it("offers only activities the content actually has", () => {
    for (let seed = 0; seed < CASES; seed += 1) {
      const next = rng(seed + 1);
      const content = generateContent(next);
      const known = new Set(content.activities.map((a) => a.id));
      const session = composeSession(
        content,
        generateProgress(next, content),
        generateSkills(next),
        DAY,
      );

      for (const a of session.activities) {
        expect(known.has(a.id), `seed ${seed}, activity ${a.id}`).toBe(true);
      }
    }
  });

  /**
   * The same day and the same state compose the same sitting. `today` is a
   * parameter rather than a clock read precisely so this is checkable — and so
   * two renders a millisecond apart cannot disagree.
   */
  it("composes the same sitting for the same day and state", () => {
    for (let seed = 0; seed < CASES; seed += 1) {
      const next = rng(seed + 1);
      const content = generateContent(next);
      const progress = generateProgress(next, content);
      const skills = generateSkills(next);

      const first = composeSession(content, progress, skills, DAY);
      const second = composeSession(content, progress, skills, new Date(DAY));

      expect(second, `seed ${seed}`).toEqual(first);
    }
  });

  /**
   * And it does not depend on the order the stored progress happens to be in.
   * Progress arrives from a merge of two devices, which imposes no order at
   * all, so a sitting that depended on it would differ between phones.
   */
  it("does not depend on the order progress was stored in", () => {
    for (let seed = 0; seed < CASES; seed += 1) {
      const next = rng(seed + 1);
      const content = generateContent(next);
      const progress = generateProgress(next, content);
      const skills = generateSkills(next);

      const asStored = composeSession(content, progress, skills, DAY);
      const reordered = composeSession(content, shuffled(progress, next), skills, DAY);

      expect(reordered.activities.map((a) => a.id), `seed ${seed}`).toEqual(
        asStored.activities.map((a) => a.id),
      );
      expect(reordered.reviews, `seed ${seed}`).toEqual(asStored.reviews);
    }
  });
});

describe("N3 — the estimate does not depend on arrival order", () => {
  /**
   * The critical one. Two devices sync in whatever order the network allows,
   * so an order-dependent strength means the same learner has two different
   * histories depending on which phone reconnected first.
   *
   * `strengthOf` weights by recency, so it must order by timestamp itself
   * rather than trusting the array it was handed.
   */
  it("gives the same strength however the samples arrive", () => {
    for (let seed = 0; seed < CASES; seed += 1) {
      const next = rng(seed + 1);
      const samples = generateSamples(next, 2 + Math.floor(next() * 12));

      const inOrder = strengthOf(samples);
      const jumbled = strengthOf(shuffled(samples, next));

      expect(jumbled, `seed ${seed}`).toBe(inOrder);
    }
  });

  /**
   * And the same rung. `stepFor` replays the history, climbing on a strong
   * take and resetting on a weak one — a sequence-dependent answer by design,
   * which is exactly why it must sort before replaying rather than after.
   */
  it("places a sound on the same rung however the samples arrive", () => {
    for (let seed = 0; seed < CASES; seed += 1) {
      const next = rng(seed + 1);
      const samples = generateSamples(next, 2 + Math.floor(next() * 12));

      expect(stepFor(shuffled(samples, next)), `seed ${seed}`).toBe(stepFor(samples));
    }
  });

  it("schedules the same reviews however the whole store arrives", () => {
    for (let seed = 0; seed < CASES; seed += 1) {
      const next = rng(seed + 1);
      const skills = generateSkills(next);

      const jumbled: SkillStore = {};
      for (const grapheme of shuffled(Object.keys(skills), next)) {
        const skill = skills[grapheme];
        if (skill === undefined) continue;
        jumbled[grapheme] = { ...skill, samples: shuffled(skill.samples, next) };
      }

      expect(allReviews(jumbled, DAY), `seed ${seed}`).toEqual(allReviews(skills, DAY));
    }
  });
});
