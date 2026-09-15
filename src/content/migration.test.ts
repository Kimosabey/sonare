/**
 * N1 — a learner's existing progress survives the move to a course.
 *
 * The flat sets shipped first: a language was a list of phrases, and progress
 * was a list of `{activityId, passed}` against it. The course spine arrived as
 * a **new published version** of the same language, with the same activity ids
 * pointing into units and lessons.
 *
 * So the migration is not a migration — nothing is rewritten, and that is the
 * design. What has to be true is that the same stored progress, read against
 * the new shape, still says the learner did what they did. The failure this
 * guards against is silent and total: a learner who passed ten phrases opens
 * the app after a content release and finds a course with nothing done in it.
 *
 * Both directions matter, because content is versioned and a device can be on
 * either side of a release:
 *
 *  - **Old progress, new content.** The common case, and the one above.
 *  - **New progress, old content.** A learner who practised on a phone that had
 *    the course, syncing to a tablet that has not fetched it yet. Nothing may
 *    be lost there either — the tablet fetches the course later and must find
 *    the record intact.
 */

import { describe, expect, it } from "vitest";
import { journeyFor } from "../learning/journey.js";
import { composeSession } from "../learning/composeSession.js";
import type { Activity, ActivityProgress, LanguageActivitySet } from "../activities/types.js";

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

const ACTIVITIES = [
  activity(1, ["bon"]),
  activity(2, ["jour"]),
  activity(3, ["soir"]),
  activity(4, ["mer"]),
  activity(5, ["ci"]),
  activity(6, ["vous"]),
];

/** The shape that shipped: a language is a list of phrases. */
const FLAT: LanguageActivitySet = {
  code: "fr-FR",
  slug: "fr",
  label: "French",
  activities: ACTIVITIES,
};

/**
 * The same language, republished with a spine. The activity **ids are
 * unchanged** — that is the whole mechanism, and the reason nothing has to be
 * rewritten.
 */
const COURSE: LanguageActivitySet = {
  ...FLAT,
  units: [
    {
      id: 1,
      title: "Meeting people",
      outcome: "You can greet someone and be understood.",
      lessons: [
        { id: 1, title: "Hello", outcome: "You can say hello.", activityIds: [1, 2, 3] },
        { id: 2, title: "Goodbye", outcome: "You can say goodbye.", activityIds: [4, 5, 6] },
      ],
    },
  ],
};

/** Progress as a learner on the flat set would have left it. */
function flatProgress(passedIds: number[]): ActivityProgress[] {
  return passedIds.map((activityId) => ({
    activityId,
    attempts: [
      {
        kind: "spoken" as const,
        activityId,
        result: {} as never,
        accuracy: 88,
        at: "2026-08-01T09:00:00.000Z",
      },
    ],
    best: 88,
    passed: true,
    skipped: false,
  }));
}

const DAY = new Date("2026-09-15T09:00:00.000Z");

describe("old progress, read against the new course", () => {
  /**
   * The one that matters. A learner who passed the first three phrases must
   * open the course and find its first lesson finished — not a fresh course
   * with nothing in it.
   */
  it("still counts every activity the learner passed", () => {
    const journey = journeyFor(COURSE, flatProgress([1, 2, 3]), {});
    const unit = journey.units[0];

    expect(unit?.lessons[0]).toMatchObject({ done: 3, total: 3, state: "done" });
    expect(unit?.lessonsDone).toBe(1);
  });

  it("puts the learner where they actually stopped", () => {
    const journey = journeyFor(COURSE, flatProgress([1, 2, 3]), {});
    const current = journey.units[0]?.lessons.filter((l) => l.state === "current");

    expect(current).toHaveLength(1);
    expect(current?.[0]?.id).toBe(2);
  });

  it("keeps a partly-finished lesson partly finished", () => {
    const journey = journeyFor(COURSE, flatProgress([1, 4]), {});
    const unit = journey.units[0];

    expect(unit?.lessons[0]?.done).toBe(1);
    expect(unit?.lessons[1]?.done).toBe(1);
  });

  it("carries the attempt history through, so nothing looks unpractised", () => {
    const journey = journeyFor(COURSE, flatProgress([1]), {});

    expect(journey.units[0]?.lastPractisedAt).toBe("2026-08-01T09:00:00.000Z");
  });

  /**
   * A learner who finished the whole flat set opens a completed course. The
   * outcome still waits on the sounds — which is N4's rule, not a migration
   * failure — but nothing about the *lessons* may have reset.
   */
  it("shows a finished flat set as a finished course", () => {
    const journey = journeyFor(COURSE, flatProgress([1, 2, 3, 4, 5, 6]), {});

    expect(journey.units[0]?.state).toBe("done");
    expect(journey.units[0]?.lessonsDone).toBe(2);
  });
});

describe("the sitting across the same move", () => {
  /**
   * The composer uses progress to choose *which sitting*, not to filter within
   * one — a learner may retry a passed activity to beat their own score, so a
   * sitting keeps all of its activities. What must survive the move is that the
   * chosen sitting reflects what the learner actually did.
   */
  it("offers the sitting after the ones the learner finished", () => {
    const done = composeSession(COURSE, flatProgress([1, 2, 3]), {}, DAY);

    expect(done.lesson?.id).toBe(2);
    expect(done.activities.map((a) => a.id)).toEqual([4, 5, 6]);
  });

  it("offers the first sitting to a learner who has done nothing", () => {
    const fresh = composeSession(COURSE, [], {}, DAY);

    expect(fresh.lesson?.id).toBe(1);
  });

  /**
   * The spine changes *what is offered together*, which is the point of
   * publishing one — a lesson is a sitting. What it must not change is the
   * learner's record, which the assertions above cover.
   */
  it("composes from the spine once there is one", () => {
    expect(composeSession(FLAT, [], {}, DAY).source).toBe("window");
    expect(composeSession(COURSE, [], {}, DAY).source).toBe("lesson");
  });
});

describe("new progress, read against content that has not caught up", () => {
  /**
   * The reverse direction: a learner practised on a device that had the
   * course, and this one has not fetched it yet. Nothing may be lost — the
   * record is the same shape either way, and the spine is a view over it.
   */
  it("reads course-era progress against the flat set and still moves the learner on", () => {
    const stored = flatProgress([1, 2, 3, 4]);
    const session = composeSession(FLAT, stored, {}, DAY);

    expect(journeyFor(FLAT, stored, {}).flat).toBe(true);
    // Past the four it knows are finished, rather than back at the beginning.
    expect(session.activities.map((a) => a.id)).toContain(5);
  });

  /**
   * The same stored record, read by both devices. Neither rewrites it, which
   * is what lets a household run one phone on the course and a tablet on the
   * flat set for as long as it takes the tablet to fetch.
   */
  it("finds the record intact once the course arrives", () => {
    const stored = flatProgress([1, 2, 3]);

    const onFlat = composeSession(FLAT, stored, {}, DAY);
    const onCourse = journeyFor(COURSE, stored, {});

    expect(onFlat.activities.map((a) => a.id)).toContain(4);
    expect(onCourse.units[0]?.lessons[0]?.state).toBe("done");
    // And the record itself is untouched by either reading.
    expect(stored).toEqual(flatProgress([1, 2, 3]));
  });
});

describe("progress naming activities the content no longer has", () => {
  /**
   * Content is immutable per version, but a learner can hold progress from a
   * version whose activities were later replaced. An unknown id must be
   * ignored rather than crashing or counting toward a lesson it is not in.
   */
  it("ignores an id the course does not contain", () => {
    const journey = journeyFor(COURSE, flatProgress([1, 2, 3, 99]), {});

    expect(journey.units[0]?.lessons[0]).toMatchObject({ done: 3, total: 3 });
    expect(journey.units[0]?.lessonsTotal).toBe(2);
  });

  it("composes a sitting without tripping over it", () => {
    const session = composeSession(COURSE, flatProgress([99]), {}, DAY);

    expect(session.activities.length).toBeGreaterThan(0);
  });
});
