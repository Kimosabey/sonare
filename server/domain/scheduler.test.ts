/**
 * What to practise next, and the line the scheduler must not cross.
 *
 * The line first, because it is the part that would do real harm. This decides
 * *what* to practise, never *whether the learner succeeded*: that number comes
 * from the provider or it is not shown (R3), and the streak counts attendance
 * and takes no score. A sound dropping back to the first interval is a
 * scheduling decision, not a verdict — so nothing here returns a pass, a fail,
 * or a band, and there is a structural test saying so.
 *
 * Then the scheduling itself, where the failures are subtler: a flat mean that
 * keeps punishing a learner for takes from before they learned the sound, a
 * gentle step-down that keeps showing an unmade sound at ever-longer
 * intervals, and a tie-break that offers the same activity forever.
 */

import { describe, expect, it } from "vitest";
import {
  LADDER,
  dueSounds,
  scheduleFor,
  selectActivity,
  stepFor,
  strengthOf,
  type SchedulableActivity,
  type SkillSchedule,
} from "./scheduler.js";
import type { Skill, SkillSample } from "./merge.js";

const NOW = new Date("2026-09-07T12:00:00.000Z");

/** Samples `daysAgo` days back, one per entry. */
function history(entries: Array<[daysAgo: number, accuracy: number]>): SkillSample[] {
  return entries.map(([daysAgo, accuracy]) => ({
    at: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(),
    accuracy,
  }));
}

function skill(grapheme: string, samples: SkillSample[]): Skill {
  return { grapheme, samples };
}

function activity(over: Partial<SchedulableActivity> = {}): SchedulableActivity {
  return { id: 1, graphemes: [], passed: false, lastAttemptAt: null, ...over };
}

function schedule(grapheme: string, strength: number): SkillSchedule {
  return { grapheme, strength, samples: 5, step: 0, due: "2026-09-07", isDue: true };
}

describe("it schedules, it does not judge", () => {
  it("returns nothing resembling a verdict", () => {
    /**
     * A structural check on the rule. If a `passed`, `band` or `grade` field
     * ever appears here, some screen will start showing it — and the learner
     * will be told they failed something by a module that has no business
     * making that call.
     */
    const result = scheduleFor(skill("ment", history([[1, 40]])), NOW);

    expect(Object.keys(result).sort()).toEqual(["due", "grapheme", "isDue", "samples", "step", "strength"]);
    for (const forbidden of ["passed", "failed", "band", "grade", "score", "verdict"]) {
      expect(forbidden in result).toBe(false);
    }
  });

  it("describes a weak sound without calling it a failure", () => {
    // Dropping to the first rung is about tomorrow's practice, not today's
    // result.
    const weak = scheduleFor(skill("ment", history([[5, 90], [1, 20]])), NOW);

    expect(weak.step).toBe(0);
    expect(weak.strength).toBeLessThan(60);
    // And says nothing about the take that produced it.
    expect(weak).not.toHaveProperty("passed");
  });

  it("says why an activity was chosen, so a screen can be honest", () => {
    // Rather than leaving the UI to write "recommended for you", which is
    // both vague and unfalsifiable.
    const selection = selectActivity([activity({ graphemes: ["ment"] })], [schedule("ment", 40)]);

    expect(selection?.reason).toBe("due-sounds");
    expect(selection?.covers).toEqual(["ment"]);
  });
});

describe("strength weights recent takes more heavily", () => {
  it("is the single accuracy when there is one sample", () => {
    expect(strengthOf(history([[1, 73]]))).toBe(73);
  });

  it("is zero for no samples", () => {
    // Callers must not read this as "said badly" — `samples` is what
    // distinguishes them, and dueSounds filters on it.
    expect(strengthOf([])).toBe(0);
  });

  it("counts a recent improvement above an old struggle", () => {
    /**
     * A sound fixed last week is fixed. A flat mean would keep punishing the
     * learner for takes from before they learned it, which is the opposite of
     * what a progress figure is for.
     */
    const improving = strengthOf(history([[20, 30], [10, 50], [1, 90]]));
    const flatMean = (30 + 50 + 90) / 3;

    expect(improving).toBeGreaterThan(flatMean);
  });

  it("counts a recent regression below an old success", () => {
    const declining = strengthOf(history([[20, 90], [10, 70], [1, 30]]));

    expect(declining).toBeLessThan((90 + 70 + 30) / 3);
  });

  it("does not let one good take declare a long problem solved", () => {
    // Linear rather than exponential weighting, for exactly this.
    const mostlyBad = strengthOf(history([[20, 20], [15, 25], [10, 20], [5, 25], [1, 95]]));

    expect(mostlyBad).toBeLessThan(60);
  });

  it("is order-independent of how the samples arrive", () => {
    // Sync can deliver them in any order; the weighting is by timestamp.
    const forwards = history([[20, 30], [10, 50], [1, 90]]);
    const shuffled = [forwards[1], forwards[2], forwards[0]] as SkillSample[];

    expect(strengthOf(shuffled)).toBe(strengthOf(forwards));
  });
});

describe("climbing and falling down the ladder", () => {
  it("starts at the first rung", () => {
    expect(stepFor(history([[1, 70]]))).toBe(0);
  });

  it("climbs one rung per strong take", () => {
    expect(stepFor(history([[5, 90]]))).toBe(1);
    expect(stepFor(history([[5, 90], [4, 85]]))).toBe(2);
    expect(stepFor(history([[5, 90], [4, 85], [3, 92]]))).toBe(3);
  });

  it("stops at the top of the ladder", () => {
    const many = history(Array.from({ length: 20 }, (_, i) => [20 - i, 95] as [number, number]));

    expect(stepFor(many)).toBe(LADDER.length - 1);
  });

  it("falls all the way back on a weak take, not one rung", () => {
    /**
     * Stepping down gently means a learner keeps being shown a sound they
     * cannot yet make at ever-longer intervals — which is precisely backwards.
     * A sound that has stopped working needs practice tomorrow.
     */
    const climbed = history([[9, 95], [8, 95], [7, 95], [6, 95]]);
    expect(stepFor(climbed)).toBe(4);

    expect(stepFor([...climbed, ...history([[1, 40]])])).toBe(0);
  });

  it("holds on a middling take", () => {
    // Neither reliable nor lost. Repeating the same interval is the honest
    // response to "no new information".
    const held = history([[5, 90], [1, 70]]);

    expect(stepFor(held)).toBe(1);
  });
});

describe("when a sound comes due", () => {
  it("is due the day after a weak take", () => {
    const result = scheduleFor(skill("ment", history([[1, 40]])), NOW);

    expect(result.step).toBe(0);
    expect(result.isDue).toBe(true);
  });

  it("is not due again immediately after a strong one", () => {
    // One strong take climbs to the second rung, which is three days.
    const result = scheduleFor(skill("ment", history([[0, 95]])), NOW);

    expect(result.isDue).toBe(false);
    expect(result.step).toBe(1);
    expect(result.due).toBe("2026-09-10");
  });

  it("measures the interval from the last take, not from today", () => {
    // Otherwise a sound practised a month ago would look freshly scheduled.
    const result = scheduleFor(skill("ment", history([[30, 95]])), NOW);

    expect(result.isDue).toBe(true);
  });

  it("comes due exactly on the day, not the day after", () => {
    // Two strong takes reaches LADDER[2], which is seven days — and the last
    // was seven days ago, so it falls due today rather than tomorrow.
    const result = scheduleFor(skill("ment", history([[8, 95], [7, 95]])), NOW);

    expect(result.step).toBe(2);
    expect(result.due).toBe("2026-09-07");
    expect(result.isDue).toBe(true);
  });

  it("spaces a well-established sound out to the top interval", () => {
    // Four strong takes reaches the last rung: thirty-five days.
    const result = scheduleFor(skill("ment", history([[4, 95], [3, 95], [2, 95], [1, 95]])), NOW);

    expect(result.step).toBe(4);
    expect(result.due).toBe("2026-10-11");
    expect(result.isDue).toBe(false);
  });

  it("survives a sound with no samples at all", () => {
    expect(() => scheduleFor(skill("ment", []), NOW)).not.toThrow();
  });

  it("survives an unparseable timestamp", () => {
    // Records written by an older build, replayed through the fallback log.
    const bad: SkillSample[] = [{ at: "not-a-date", accuracy: 50 }];

    expect(() => scheduleFor(skill("ment", bad), NOW)).not.toThrow();
  });
});

describe("the due list", () => {
  it("puts the weakest sound first", () => {
    const sounds = dueSounds(
      [
        skill("jour", history([[3, 70], [2, 72]])),
        skill("ment", history([[3, 30], [2, 35]])),
        skill("vous", history([[3, 55], [2, 50]])),
      ],
      NOW,
    );

    expect(sounds.map((s) => s.grapheme)).toEqual(["ment", "vous", "jour"]);
  });

  it("excludes a sound with too little history", () => {
    /**
     * One bad take is not a pattern. Telling a learner their worst sound is
     * something they fluffed once sends them to practise the wrong thing — the
     * same threshold report.ts applies within a session.
     */
    const sounds = dueSounds([skill("ment", history([[1, 10]]))], NOW);

    expect(sounds).toEqual([]);
  });

  it("excludes a sound that is not due yet", () => {
    const sounds = dueSounds([skill("ment", history([[0, 95], [0, 92]]))], NOW);

    expect(sounds).toEqual([]);
  });

  it("is empty rather than throwing when nothing is known", () => {
    expect(dueSounds([], NOW)).toEqual([]);
  });

  it("breaks a strength tie deterministically", () => {
    // So two runs of the same data present the same order.
    const sounds = dueSounds(
      [skill("zzz", history([[3, 50], [2, 50]])), skill("aaa", history([[3, 50], [2, 50]]))],
      NOW,
    );

    expect(sounds.map((s) => s.grapheme)).toEqual(["aaa", "zzz"]);
  });
});

describe("choosing the activity", () => {
  it("prefers the one covering the most due sounds", () => {
    /**
     * The whole reason for scheduling over syllables rather than activities:
     * you cannot practise a sound alone, so the best phrase is the one that
     * drills several at once.
     */
    const selection = selectActivity(
      [
        activity({ id: 1, graphemes: ["ment"] }),
        activity({ id: 2, graphemes: ["ment", "jour", "vous"] }),
        activity({ id: 3, graphemes: ["autre"] }),
      ],
      [schedule("ment", 30), schedule("jour", 40), schedule("vous", 50)]
    );

    expect(selection?.activityId).toBe(2);
    expect(selection?.covers).toEqual(["ment", "jour", "vous"]);
  });

  it("breaks a coverage tie toward the weaker sounds", () => {
    const selection = selectActivity(
      [activity({ id: 1, graphemes: ["jour"] }), activity({ id: 2, graphemes: ["ment"] })],
      [schedule("ment", 20), schedule("jour", 70)]
    );

    expect(selection?.activityId).toBe(2);
  });

  it("breaks a remaining tie toward the least recently practised", () => {
    // So two equally useful activities alternate rather than one being offered
    // forever.
    const selection = selectActivity(
      [
        activity({ id: 1, graphemes: ["ment"], lastAttemptAt: "2026-09-06T10:00:00.000Z" }),
        activity({ id: 2, graphemes: ["jour"], lastAttemptAt: "2026-09-01T10:00:00.000Z" }),
      ],
      [schedule("ment", 40), schedule("jour", 40)]
    );

    expect(selection?.activityId).toBe(2);
  });

  it("ignores sounds an activity covers that are not due", () => {
    const selection = selectActivity(
      [activity({ id: 1, graphemes: ["ment", "not-due", "also-not"] }), activity({ id: 2, graphemes: ["jour", "vous"] })],
      [schedule("jour", 50), schedule("vous", 55)]
    );

    expect(selection?.activityId).toBe(2);
  });

  it("offers something unpractised when nothing is due", () => {
    /**
     * A learner with no due sounds has not run out of things to do, and
     * returning nothing there would be a blank screen for someone doing well.
     */
    const selection = selectActivity(
      [activity({ id: 1, lastAttemptAt: "2026-09-01T10:00:00.000Z", passed: true }), activity({ id: 2, lastAttemptAt: null })],
      []
    );

    expect(selection).toEqual({ activityId: 2, covers: [], reason: "unpractised" });
  });

  it("offers the oldest unpassed activity when everything has been tried", () => {
    const selection = selectActivity(
      [
        activity({ id: 1, lastAttemptAt: "2026-09-06T10:00:00.000Z", passed: true }),
        activity({ id: 2, lastAttemptAt: "2026-09-02T10:00:00.000Z", passed: false }),
        activity({ id: 3, lastAttemptAt: "2026-09-05T10:00:00.000Z", passed: false }),
      ],
      []
    );

    expect(selection).toEqual({ activityId: 2, covers: [], reason: "weakest-unpassed" });
  });

  it("still offers something when everything is passed and nothing is due", () => {
    const selection = selectActivity(
      [
        activity({ id: 1, lastAttemptAt: "2026-09-06T10:00:00.000Z", passed: true }),
        activity({ id: 2, lastAttemptAt: "2026-09-01T10:00:00.000Z", passed: true }),
      ],
      []
    );

    expect(selection?.activityId).toBe(2);
  });

  it("returns nothing only when there are no activities at all", () => {
    expect(selectActivity([], [schedule("ment", 20)])).toBeNull();
  });

  it("falls back for activities with no known syllables", () => {
    /**
     * An activity's syllables are learned once it has been scored, so a set
     * the learner has never touched has an empty list. It must still be
     * offerable, or a new learner would be shown nothing.
     */
    const selection = selectActivity([activity({ id: 7, graphemes: [] })], [schedule("ment", 20)]);

    expect(selection?.activityId).toBe(7);
    expect(selection?.reason).toBe("unpractised");
  });
});
