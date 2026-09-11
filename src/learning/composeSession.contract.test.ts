/**
 * The contract between the two things that could disagree about "what next".
 *
 * `composeSession` composes locally and always. The server's `GET /next` also
 * ranks sounds and picks an activity, and it is better at it — it alone sees
 * every device's history. So it is an **input** to the composer, never an
 * alternative to it.
 *
 * That distinction is the whole design, and it is worthless unless something
 * enforces it. Two implementations of "what next" drift silently, and the
 * learner finds out by watching their session change when they come online.
 *
 * So: **composing with a refinement and without it differs only in ordering,
 * never in membership.** A refinement may reorder the sitting. It may not add
 * an activity, remove one, or change which sounds are due.
 *
 * `composeSession.ts`'s own header names this file and makes that claim. This
 * is what turns the claim into something checkable.
 */

import { describe, expect, it } from "vitest";
import { composeSession, type SessionRefinement } from "./composeSession.js";
import type { Activity, ActivityProgress, LanguageActivitySet } from "../activities/types.js";
import type { SkillStore } from "../stores/skillStore.js";

const DAY = new Date("2026-09-12T09:00:00.000Z");

function activity(id: number, over: Partial<Activity> = {}): Activity {
  return {
    id,
    title: `Activity ${id}`,
    kind: "repeat",
    prompt: `Say phrase ${id}`,
    gloss: `Phrase ${id}`,
    target: `Phrase ${id}`,
    focus: `focus ${id}`,
    ...over,
  };
}

/** A flat set — the shape that already shipped, with no spine. */
function flatSet(count = 8): LanguageActivitySet {
  return {
    code: "fr-FR",
    slug: "fr",
    label: "French",
    activities: Array.from({ length: count }, (_, i) =>
      activity(i + 1, { soundTargets: [`syl${i + 1}`] }),
    ),
  };
}

/** Skill history old enough that the sounds are due. */
function dueSkills(graphemes: string[]): SkillStore {
  const store: SkillStore = {};
  for (const g of graphemes) {
    store[g] = {
      grapheme: g,
      samples: [
        { at: "2026-01-01T09:00:00.000Z", accuracy: 40 },
        { at: "2026-01-02T09:00:00.000Z", accuracy: 45 },
      ],
    };
  }
  return store;
}

const NO_PROGRESS: ActivityProgress[] = [];

describe("a refinement changes order, never membership", () => {
  /**
   * The central assertion. Every refinement the server can express is applied
   * to the same inputs, and the *set* of activities must be identical each
   * time — only their sequence may move.
   */
  it("offers exactly the same activities with and without a refinement", () => {
    const content = flatSet();
    const skills = dueSkills(["syl3", "syl5"]);

    const local = composeSession(content, NO_PROGRESS, skills, DAY);

    const reasons: SessionRefinement["reason"][] = [
      "due-sounds",
      "unpractised",
      "weakest-unpassed",
    ];

    for (const reason of reasons) {
      for (const id of content.activities.map((a) => a.id)) {
        const refined = composeSession(content, NO_PROGRESS, skills, DAY, {
          activityId: id,
          reason,
          covers: ["syl3"],
        });

        expect([...refined.activities].map((a) => a.id).sort((x, y) => x - y)).toEqual(
          [...local.activities].map((a) => a.id).sort((x, y) => x - y),
        );
      }
    }
  });

  it("does not change which sounds are due", () => {
    const content = flatSet();
    const skills = dueSkills(["syl2", "syl6"]);

    const local = composeSession(content, NO_PROGRESS, skills, DAY);
    const refined = composeSession(content, NO_PROGRESS, skills, DAY, {
      activityId: 6,
      reason: "due-sounds",
      covers: ["syl6"],
    });

    expect(refined.reviews).toEqual(local.reviews);
  });

  it("does not change the lesson the sitting came from", () => {
    const content = flatSet();
    const skills = dueSkills(["syl4"]);

    const local = composeSession(content, NO_PROGRESS, skills, DAY);
    const refined = composeSession(content, NO_PROGRESS, skills, DAY, {
      activityId: 4,
      reason: "due-sounds",
      covers: ["syl4"],
    });

    expect(refined.lesson).toEqual(local.lesson);
  });

  /**
   * The server does not know which spine this client is reading — it may be
   * serving `fr:2` to a device still on the bundled flat set. So a pick that
   * is not in today's sitting is a preference about sounds, not a claim about
   * membership, and the local ordering stands.
   */
  it("is inert when it names an activity outside today's sitting", () => {
    const content = flatSet();
    const skills = dueSkills(["syl1"]);

    const local = composeSession(content, NO_PROGRESS, skills, DAY);
    const outside = Math.max(...content.activities.map((a) => a.id)) + 99;

    const refined = composeSession(content, NO_PROGRESS, skills, DAY, {
      activityId: outside,
      reason: "due-sounds",
      covers: ["syl1"],
    });

    expect(refined.activities.map((a) => a.id)).toEqual(local.activities.map((a) => a.id));
    // Optional-chained because `opening` is nullable by design — see the note
    // in the test below. Narrowing here would assert the wrong thing: what
    // matters is that the refinement did not claim the opening, not that an
    // opening exists at all.
    expect(refined.opening?.from).toBe("local");
  });

  it("says whose evidence opened the sitting, rather than implying it", () => {
    /**
     * `opening` is nullable on purpose: a sitting has no opening when no due
     * sound maps to an activity *in today's window*. So the due sound here is
     * chosen from the composed sitting rather than guessed — picking one whose
     * activity falls outside the window tests nothing but the null branch.
     */
    const content = flatSet();
    const probe = composeSession(content, NO_PROGRESS, dueSkills(["syl1"]), DAY);
    const inSitting = probe.activities[0];
    expect(inSitting).toBeDefined();
    const grapheme = inSitting?.soundTargets?.[0] ?? "syl1";

    const skills = dueSkills([grapheme]);
    const local = composeSession(content, NO_PROGRESS, skills, DAY);
    expect(local.opening).not.toBeNull();
    expect(local.opening?.from).toBe("local");

    const last = local.activities[local.activities.length - 1]?.id ?? 1;
    const refined = composeSession(content, NO_PROGRESS, skills, DAY, {
      activityId: last,
      reason: "due-sounds",
      covers: [grapheme],
    });

    expect(refined.opening?.from).toBe("server");
    expect(refined.opening?.activityId).toBe(last);
  });
});

describe("purity", () => {
  /**
   * `today` is a parameter rather than a clock read, so a year of days can be
   * swept in a test — and so the two lists cannot disagree about whether a
   * sound is due because composition straddled midnight.
   */
  it("composes the same sitting for the same day, however many times it is asked", () => {
    const content = flatSet();
    const skills = dueSkills(["syl2", "syl3"]);

    const first = composeSession(content, NO_PROGRESS, skills, DAY);
    const second = composeSession(content, NO_PROGRESS, skills, new Date(DAY));

    expect(second).toEqual(first);
  });

  it("does not mutate what it was given", () => {
    const content = flatSet();
    const skills = dueSkills(["syl1"]);
    const progress: ActivityProgress[] = [];

    const contentBefore = JSON.stringify(content);
    const skillsBefore = JSON.stringify(skills);

    composeSession(content, progress, skills, DAY);

    expect(JSON.stringify(content)).toBe(contentBefore);
    expect(JSON.stringify(skills)).toBe(skillsBefore);
    expect(progress).toEqual([]);
  });
});
