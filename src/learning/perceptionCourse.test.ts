/**
 * A course made only of the kinds that never open the microphone.
 *
 * This exists because of a language, not a feature. Azure returns **no
 * syllable graphemes** for Kannada — 0 of 0 on every phrase measured — and 0
 * of 7 for Hindi. Phoneme-level scoring is the product, so for those two
 * languages a score would be a number with nothing to act on: a learner told
 * "78" and never told which sound to fix. That is why both sit in `PLANNED`
 * rather than shipping.
 *
 * But `listen` and `locate` ask nothing of the scorer and nothing of the
 * microphone. They play a phrase and take a choice. So a **perception course**
 * — every activity a silent kind — is honest in a language the scorer cannot
 * assess: it teaches hearing the difference, and never claims to measure
 * production.
 *
 * That was a claim, and this file is what turns it into a fact. It asserts the
 * three things such a course must do before anybody is asked to author one:
 * publish, compose a real question for every activity, and produce a sitting.
 *
 * ## The fixture is deliberately nonsense
 *
 * NATO words, not Kannada. Inventing Kannada here would be inventing content
 * no Kannada speaker has checked, in a file whose whole purpose is to say what
 * a Kannada speaker must supply. The rules being tested are about *kinds*, not
 * about any language, so a language-free fixture tests them honestly and
 * cannot be mistaken for shippable content.
 *
 * ## What it also pins, and this is the caveat
 *
 * A perception course gets **no spaced repetition**. Nothing in it produces an
 * accuracy, so no sound ever becomes due and the scheduler has nothing to
 * order. The sitting is the content, in order. That is a real limitation and
 * it is asserted below rather than left for somebody to discover after
 * authoring a course.
 */

import { describe, expect, it } from "vitest";
import { composeSession } from "./composeSession.js";
import { affordancesFor } from "./affordances.js";
import { draftFromSet, draftProblems } from "../content/draft.js";
import { locateOptions, LOCATE_OPTIONS } from "../activities/locate.js";
import { listenOptions } from "../activities/listen.js";
import type { LanguageActivitySet } from "../activities/types.js";

const DAY = new Date("2026-09-18T09:00:00.000Z");

/**
 * Six activities, four `locate` and two `listen`.
 *
 * Four distinct sound targets is not arbitrary: `locate` draws its wrong
 * answers from syllables *other* phrases drill, and asks for
 * `LOCATE_OPTIONS` of them. A set with fewer cannot compose a question at all.
 */
const PERCEPTION: LanguageActivitySet = {
  code: "xx-XX",
  slug: "xx",
  label: "Probe",
  activities: [
    locate(1, "alpha bravo", "alph"),
    locate(2, "charlie delta", "char"),
    locate(3, "echo foxtrot", "echo"),
    locate(4, "golf hotel", "golf"),
    listen(5, "india juliet", ["india romeo"]),
    listen(6, "kilo lima", ["kilo mike"]),
  ],
};

function locate(id: number, target: string, syllable: string) {
  return {
    id,
    title: `Activity ${String(id)}`,
    kind: "locate" as const,
    prompt: "Listen, then choose which sound was in the phrase.",
    gloss: `Gloss ${String(id)}`,
    target,
    focus: `hearing ${syllable}`,
    soundTargets: [syllable],
  };
}

function listen(id: number, target: string, distractors: string[]) {
  return {
    id,
    title: `Activity ${String(id)}`,
    kind: "listen" as const,
    prompt: "Listen, then choose which phrase you heard.",
    gloss: `Gloss ${String(id)}`,
    target,
    focus: "telling two near-identical phrases apart",
    distractors,
  };
}

describe("a course of nothing but perception", () => {
  it("is publishable", () => {
    expect(draftProblems(draftFromSet(PERCEPTION))).toEqual([]);
  });

  it("asks nothing of the microphone, anywhere in it", () => {
    for (const activity of PERCEPTION.activities) {
      expect(
        affordancesFor(activity.kind, { takes: 0, revealed: false }).needsMicrophone,
        `activity ${String(activity.id)}`,
      ).toBe(false);
    }
  });

  /**
   * Every activity has to be answerable. A `locate` that composes nothing
   * renders an honest refusal, which in a course made entirely of them would
   * be a course of refusals — publishable, reachable, and empty.
   */
  it("composes a real question for every activity", () => {
    for (const activity of PERCEPTION.activities) {
      if (activity.kind === "locate") {
        const options = locateOptions(activity, PERCEPTION);
        expect(options, `activity ${String(activity.id)}`).not.toBeNull();
        expect(options?.length).toBe(LOCATE_OPTIONS);
        expect(options?.filter((option) => option.correct)).toHaveLength(1);
      } else {
        const options = listenOptions(activity);
        expect(options.length, `activity ${String(activity.id)}`).toBeGreaterThan(1);
        expect(options.filter((option) => option.correct)).toHaveLength(1);
      }
    }
  });

  it("produces a sitting a learner can actually do", () => {
    const session = composeSession(PERCEPTION, [], {}, DAY);

    expect(session.activities.length).toBeGreaterThan(0);
    for (const activity of session.activities) {
      expect(["listen", "locate"]).toContain(activity.kind);
    }
  });

  /**
   * The caveat, asserted rather than left to be discovered.
   *
   * The scheduler orders a sitting by which sounds are due, and a sound
   * becomes due from accuracies. A perception course produces none, so there
   * is nothing to be due and nothing to open on. Anybody authoring one should
   * know it is a linear course before they write it, not after.
   */
  it("has no sounds due for review, because nothing in it is scored", () => {
    const session = composeSession(PERCEPTION, [], {}, DAY);

    expect(session.reviews).toEqual([]);
    expect(session.opening).toBeNull();
  });

  /**
   * Non-vacuity for the assertion above: the same composer *does* find work to
   * do when the set contains a kind that scores, so "no reviews" is a fact
   * about perception courses rather than about this test's inputs.
   */
  it("still schedules review when the course contains something scored", () => {
    const mixed: LanguageActivitySet = {
      ...PERCEPTION,
      activities: [
        ...PERCEPTION.activities,
        {
          id: 7,
          title: "Activity 7",
          kind: "repeat",
          prompt: "Say it back",
          gloss: "Gloss 7",
          target: "mike november",
          focus: "the mike sound",
          soundTargets: ["mike"],
        },
      ],
    };
    const skills = {
      mike: {
        grapheme: "mike",
        samples: [
          { at: "2026-01-01T09:00:00.000Z", accuracy: 40 },
          { at: "2026-01-02T09:00:00.000Z", accuracy: 45 },
        ],
      },
    };

    const session = composeSession(mixed, [], skills, DAY);

    expect(session.reviews.length).toBeGreaterThan(0);
  });
});
