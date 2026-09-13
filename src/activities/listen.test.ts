/**
 * The question a `listen` activity asks.
 *
 * Two properties matter more than the rest, and both are about a learner being
 * told they are wrong when they are not:
 *
 *  - **An unaskable activity produces no question.** One option, or a
 *    distractor identical to the target, renders as a working exercise and
 *    teaches the opposite of the lesson. The publish gate refuses both; this
 *    is the second line, for the sets that ship in the bundle and never pass
 *    through it.
 *  - **An option's identity is not its position.** A `ChosenAttempt` stores
 *    the id it picked and outlives the content version it was made against.
 */

import { describe, expect, it } from "vitest";
import { TARGET_OPTION_ID, isCorrectChoice, listenOptions } from "./listen.js";
import type { Activity } from "./types.js";

function listen(over: Partial<Activity> = {}): Activity {
  return {
    id: 1,
    title: "Which did you hear?",
    kind: "listen",
    prompt: "Which phrase did you hear?",
    gloss: "fish / poison",
    target: "poisson",
    focus: "the doubled s",
    distractors: ["poison"],
    ...over,
  };
}

describe("the options offered", () => {
  it("offers the target and every authored near-miss, once each", () => {
    const options = listenOptions(listen({ distractors: ["poison", "boisson"] }));

    expect(options.map((o) => o.text).sort()).toEqual(["boisson", "poison", "poisson"]);
    expect(options.filter((o) => o.correct)).toHaveLength(1);
  });

  it("marks exactly the target correct", () => {
    const options = listenOptions(listen());
    const correct = options.find((o) => o.correct);

    expect(correct?.text).toBe("poisson");
    expect(correct?.id).toBe(TARGET_OPTION_ID);
  });

  /**
   * A learner who notices the answer is always first stops listening, which
   * is the one thing this activity cannot survive.
   */
  it("does not always put the answer first", () => {
    const positions = new Set(
      [1, 2, 3, 4, 5, 6].map((id) =>
        listenOptions(listen({ id, distractors: ["poison", "boisson"] })).findIndex(
          (o) => o.correct,
        ),
      ),
    );

    expect(positions.size).toBeGreaterThan(1);
  });

  /**
   * The other half of that: it must not move between renders either. A list
   * that reshuffles moves the option out from under a learner's finger, and
   * one that reshuffles on retry hands them elimination for free.
   */
  it("gives the same order every time it is asked", () => {
    const activity = listen({ id: 7, distractors: ["poison", "boisson"] });

    expect(listenOptions(activity)).toEqual(listenOptions(activity));
  });

  /** A rotation cannot drop or duplicate, and this is what says so. */
  it("is a permutation, at every id", () => {
    for (let id = 0; id < 12; id += 1) {
      const options = listenOptions(listen({ id, distractors: ["a", "b", "c"] }));
      expect(options).toHaveLength(4);
      expect(new Set(options.map((o) => o.id)).size).toBe(4);
      expect(options.map((o) => o.text).sort()).toEqual(["a", "b", "c", "poisson"]);
    }
  });
});

describe("content that cannot be asked", () => {
  it("offers nothing when there are no near-misses", () => {
    expect(listenOptions(listen({ distractors: [] }))).toEqual([]);
    expect(listenOptions(listen({ distractors: undefined }))).toEqual([]);
  });

  /**
   * Two identical options, one marked wrong. Returning the pair would show a
   * learner the right words and tell them they were wrong for picking them.
   */
  it("offers nothing when a near-miss is the target itself", () => {
    expect(listenOptions(listen({ distractors: ["poisson"] }))).toEqual([]);
    expect(listenOptions(listen({ distractors: ["poison", "poisson"] }))).toEqual([]);
  });
});

describe("judging a recorded choice", () => {
  it("accepts the id of the correct option", () => {
    expect(isCorrectChoice(listen(), TARGET_OPTION_ID)).toBe(true);
  });

  it("rejects a near-miss, and anything that is not an option at all", () => {
    expect(isCorrectChoice(listen(), "d0")).toBe(false);
    expect(isCorrectChoice(listen(), "d99")).toBe(false);
    expect(isCorrectChoice(listen(), "")).toBe(false);
  });

  /**
   * The correct option keeps its name across a republish, whatever happens to
   * the near-misses around it — including the rotation, which moves every
   * option's position as the id list stays put.
   *
   * A distractor's id is its authored position and does move; the assertion
   * below is what that costs and what it does not. It cannot turn a learner's
   * right answer into a wrong one, because `ChosenAttempt` freezes `correct`
   * at the moment they answered rather than re-deriving it from content.
   */
  it("keeps the correct option's id across a reordering of the near-misses", () => {
    const before = listen({ id: 3, distractors: ["poison", "boisson"] });
    const after = listen({ id: 3, distractors: ["boisson", "poison"] });

    expect(isCorrectChoice(before, TARGET_OPTION_ID)).toBe(true);
    expect(isCorrectChoice(after, TARGET_OPTION_ID)).toBe(true);

    // And the documented caveat, asserted rather than only described.
    const textOf = (a: Activity, id: string) => listenOptions(a).find((o) => o.id === id)?.text;
    expect(textOf(before, "d0")).toBe("poison");
    expect(textOf(after, "d0")).toBe("boisson");
  });

  it("never accepts a choice on an activity that cannot be asked", () => {
    const unaskable = listen({ distractors: [] });

    expect(isCorrectChoice(unaskable, TARGET_OPTION_ID)).toBe(false);
  });
});
