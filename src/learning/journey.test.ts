/**
 * The journey, and the one claim it must never make without evidence.
 *
 * A can-do statement is a claim about a person. `outcomeEarned` is what decides
 * whether one is shown as met, and every assertion below is a way it could be
 * shown when it has not been.
 *
 * The other property is the absence of a lock. Nothing here distinguishes
 * "open" from "not allowed", because nothing is not allowed — the states exist
 * so a rail can say where the learner was, not what they may touch.
 */

import { describe, expect, it } from "vitest";
import { HOLDING_RUNG, journeyFor } from "./journey.js";
import { REVIEW_LADDER } from "./soundReview.js";
import type { Activity, ActivityProgress, LanguageActivitySet } from "../activities/types.js";
import type { SkillStore } from "../stores/skillStore.js";

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

/** One unit, two lessons of two activities, naming two sounds. */
function course(): LanguageActivitySet {
  return {
    code: "fr-FR",
    slug: "fr",
    label: "French",
    activities: [
      activity(1, ["bon"]),
      activity(2, ["bon"]),
      activity(3, ["jour"]),
      activity(4, ["jour"]),
    ],
    units: [
      {
        id: 1,
        title: "Meeting people",
        outcome: "You can greet someone and be understood.",
        lessons: [
          { id: 1, title: "Hello", outcome: "You can say hello.", activityIds: [1, 2] },
          { id: 2, title: "Goodbye", outcome: "You can say goodbye.", activityIds: [3, 4] },
        ],
      },
    ],
  };
}

function passedAll(ids: number[]): ActivityProgress[] {
  return ids.map((activityId) => ({
    activityId,
    attempts: [],
    best: 90,
    passed: true,
    skipped: false,
  }));
}

/**
 * A sound at a chosen rung, built by replaying takes rather than by asserting
 * a number — `stepFor` climbs one rung per strong take and resets on a weak
 * one, so this is the only honest way to place a sound on the ladder.
 */
function skillAtRung(grapheme: string, rung: number): SkillStore[string] {
  return {
    grapheme,
    samples: Array.from({ length: rung }, (_, i) => ({
      at: `2026-0${String(i + 1)}-01T09:00:00.000Z`,
      accuracy: 90,
    })),
  };
}

function skills(entries: Record<string, number>): SkillStore {
  const store: SkillStore = {};
  for (const [grapheme, rung] of Object.entries(entries)) {
    store[grapheme] = skillAtRung(grapheme, rung);
  }
  return store;
}

describe("a can-do statement and its evidence", () => {
  it("is earned when every lesson is done and every sound is holding", () => {
    const journey = journeyFor(course(), passedAll([1, 2, 3, 4]), skills({ bon: 3, jour: 3 }));

    expect(journey.units[0]?.outcomeEarned).toBe(true);
    expect(journey.units[0]?.holdingSounds).toEqual(["bon", "jour"]);
  });

  /**
   * The interesting half. Every activity can be finished by exhausting tries —
   * the gate is soft on purpose — so "did all the lessons" is closer to
   * attendance than to ability, and on its own it may not claim an outcome.
   */
  it("is not earned by finishing the lessons alone", () => {
    const journey = journeyFor(course(), passedAll([1, 2, 3, 4]), skills({ bon: 0, jour: 0 }));

    expect(journey.units[0]?.state).toBe("done");
    expect(journey.units[0]?.outcomeEarned).toBe(false);
  });

  it("is not earned by holding the sounds without doing the lessons", () => {
    const journey = journeyFor(course(), [], skills({ bon: 4, jour: 4 }));

    expect(journey.units[0]?.outcomeEarned).toBe(false);
  });

  /**
   * Every sound, not most. A majority rule would let the hardest sound — the
   * one the learner actually needs — be the one that never has to hold.
   */
  it("is not earned while one of its sounds is still short of the rung", () => {
    const journey = journeyFor(
      course(),
      passedAll([1, 2, 3, 4]),
      skills({ bon: 3, jour: HOLDING_RUNG - 1 }),
    );

    expect(journey.units[0]?.outcomeEarned).toBe(false);
    expect(journey.units[0]?.holdingSounds).toEqual(["bon"]);
  });

  /**
   * Content published before sound targets existed offers no evidence at all.
   * Silence about an outcome is recoverable; a false claim about a learner's
   * ability is not.
   */
  it("is not earned when the content names no sounds to check against", () => {
    const content = course();
    const unmapped: LanguageActivitySet = {
      ...content,
      activities: content.activities.map(({ soundTargets: _drop, ...rest }) => rest),
    };

    const journey = journeyFor(unmapped, passedAll([1, 2, 3, 4]), skills({ bon: 4, jour: 4 }));

    expect(journey.units[0]?.outcomeEarned).toBe(false);
    expect(journey.units[0]?.touchedSounds).toEqual([]);
  });

  it("shows the receipts it decided on", () => {
    const journey = journeyFor(course(), passedAll([1, 2]), skills({ bon: 3 }));

    expect(journey.units[0]?.touchedSounds).toEqual(["bon", "jour"]);
    expect(journey.units[0]?.holdingSounds).toEqual(["bon"]);
  });

  /** The rung is a real position on the shipped ladder, not a loose number. */
  it("checks against a rung the ladder actually has", () => {
    expect(HOLDING_RUNG).toBeGreaterThan(0);
    expect(HOLDING_RUNG).toBeLessThan(REVIEW_LADDER.length);
  });
});

describe("where the learner is", () => {
  it("marks exactly one lesson as current", () => {
    const journey = journeyFor(course(), passedAll([1, 2]), {});
    const current = journey.units.flatMap((u) => u.lessons).filter((l) => l.state === "current");

    expect(current).toHaveLength(1);
    expect(current[0]?.id).toBe(2);
  });

  it("marks none as current once everything is done", () => {
    const journey = journeyFor(course(), passedAll([1, 2, 3, 4]), {});

    expect(journey.units.flatMap((u) => u.lessons).some((l) => l.state === "current")).toBe(false);
  });

  it("counts activities passed within a lesson", () => {
    const journey = journeyFor(course(), passedAll([1]), {});
    const first = journey.units[0]?.lessons[0];

    expect(first).toMatchObject({ done: 1, total: 2, state: "current" });
  });

  /**
   * The absence that is the point. Nothing here says "locked", and a rail
   * reading these states for a reason to disable a control is reading them
   * wrong: the line shows what follows what, not what is allowed.
   */
  it("never reports a state that means 'not allowed'", () => {
    const journey = journeyFor(course(), [], {});
    const states = journey.units.flatMap((u) => [u.state, ...u.lessons.map((l) => l.state)]);

    expect(new Set(states).size).toBeGreaterThan(0);
    for (const state of states) {
      expect(["done", "current", "open"]).toContain(state);
    }
  });

  it("reports when the unit was last practised, from the attempts themselves", () => {
    const progress: ActivityProgress[] = [
      {
        activityId: 1,
        attempts: [
          {
            kind: "spoken",
            activityId: 1,
            result: {} as never,
            accuracy: 80,
            at: "2026-09-10T09:00:00.000Z",
          },
          {
            kind: "spoken",
            activityId: 1,
            result: {} as never,
            accuracy: 85,
            at: "2026-09-12T09:00:00.000Z",
          },
        ],
        best: 85,
        passed: true,
        skipped: false,
      },
    ];

    expect(journeyFor(course(), progress, {}).units[0]?.lastPractisedAt).toBe(
      "2026-09-12T09:00:00.000Z",
    );
  });

  it("reports null when nothing in the unit has been attempted", () => {
    expect(journeyFor(course(), [], {}).units[0]?.lastPractisedAt).toBeNull();
  });
});

describe("a set with no spine", () => {
  /**
   * Flat rather than one invented unit wrapping everything. A fabricated unit
   * would need a can-do statement, and an outcome nobody wrote is exactly the
   * claim this module exists to prevent.
   */
  it("reports itself as flat rather than inventing a unit", () => {
    const withSpine = course();
    const flatSet: LanguageActivitySet = {
      code: withSpine.code,
      slug: withSpine.slug,
      label: withSpine.label,
      activities: withSpine.activities,
    };
    const journey = journeyFor(flatSet, [], {});

    expect(journey.flat).toBe(true);
    expect(journey.units).toEqual([]);
  });

  it("treats an empty spine the same way", () => {
    const journey = journeyFor({ ...course(), units: [] }, [], {});

    expect(journey.flat).toBe(true);
  });
});
