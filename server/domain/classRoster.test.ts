/**
 * The one payload in the teacher view that names people.
 *
 * Everything else a teacher sees is a group count. This is a list of children
 * with their names on it, so the question for every test here is the same:
 * what is each row allowed to say *about* the person it names?
 *
 * The board's answer is attendance, which sounds they are working on, and the
 * health of their microphone. Not one of those is a measurement of how well
 * they spoke, which is what makes the list safe to put in front of an adult
 * who grades them.
 */

import { describe, expect, it } from "vitest";
import { MIN_TAKES_FOR_CAPTURE_HEALTH, buildRoster, type PupilRecord } from "./classRoster.js";
/**
 * The two presentation helpers live on the client — they read a row that
 * already carries no figure, and how to present that is a screen's judgement.
 * Imported here because the rows this file builds are their only input, so the
 * two halves are worth exercising against each other.
 */
import {
  CAPTURE_CONCERN_RATIO,
  captureNeedsAttention,
  daysSincePractice,
} from "../../src/teacher/roster.js";
import { forbiddenPathsIn } from "../../src/teacher/promise.js";

function pupil(over: Partial<PupilRecord> = {}): PupilRecord {
  return {
    learnerId: "learner-aaaaaaaa",
    sharedName: null,
    skills: [],
    progress: [],
    ...over,
  };
}

function skill(grapheme: string, count = 3) {
  return {
    grapheme,
    samples: Array.from({ length: count }, (_, i) => ({
      at: `2026-09-0${i + 1}T09:00:00.000Z`,
      accuracy: 40 + i,
    })),
  };
}

function attempt(day: string) {
  return { activityId: 1, passed: false, bestAccuracy: 55, attemptsUsed: 1, skipped: false, at: `${day}T09:00:00.000Z` };
}

describe("what a row may say about the person it names", () => {
  /**
   * The rows carry accuracies in — `skills` has them, `progress` has
   * `bestAccuracy` — and must carry none out. This is the assertion that the
   * conversion actually happened rather than the fields merely being ignored
   * by the screen that renders them.
   */
  it("carries no figure out, however many go in", () => {
    const rows = buildRoster([
      pupil({ sharedName: "Amara", skills: [skill("ʁ")], progress: [attempt("2026-09-14")] }),
    ]);

    expect(forbiddenPathsIn(rows)).toEqual([]);
    expect(JSON.stringify(rows)).not.toContain("55");
  });

  it("carries no learner id", () => {
    const rows = buildRoster([pupil({ learnerId: "learner-secret", sharedName: "Amara" })]);

    expect(JSON.stringify(rows)).not.toContain("learner-secret");
  });

  /**
   * Which sounds, never how well — the board says it in those words. The
   * graphemes are the same ones the class table is keyed on, so a teacher can
   * see that a pupil is on the sound the class is stuck on.
   */
  it("names the sounds a pupil is working on, as graphemes", () => {
    const rows = buildRoster([
      pupil({ sharedName: "Amara", skills: [skill("ʁ"), skill("an")] }),
    ]);

    expect(rows[0]?.workingOn).toEqual(["an", "ʁ"]);
  });

  it("does not list a sound the pupil has never attempted", () => {
    const rows = buildRoster([
      pupil({ sharedName: "Amara", skills: [skill("ʁ"), { grapheme: "u", samples: [] }] }),
    ]);

    expect(rows[0]?.workingOn).toEqual(["ʁ"]);
  });
});

describe("the order is the safeguard", () => {
  /**
   * The board calls alphabetical "the only order there is". That is the
   * mechanism rather than a default: an order by anything else would need
   * something to order by, and the whole teacher view exists without one.
   */
  it("is alphabetical", () => {
    const rows = buildRoster([
      pupil({ learnerId: "c", sharedName: "Chloe" }),
      pupil({ learnerId: "a", sharedName: "Amara" }),
      pupil({ learnerId: "b", sharedName: "Ben" }),
    ]);

    expect(rows.map((r) => r.label)).toEqual(["Amara", "Ben", "Chloe"]);
  });

  it("does not order by how much anybody practised", () => {
    const rows = buildRoster([
      pupil({ learnerId: "a", sharedName: "Zoe", progress: [attempt("2026-09-14")] }),
      pupil({ learnerId: "b", sharedName: "Amara" }),
    ]);

    expect(rows.map((r) => r.label)).toEqual(["Amara", "Zoe"]);
  });
});

describe("a pupil who joined without a name", () => {
  /**
   * The board shows "Pupil 4" beside four named pupils and says it "joined
   * without a name, which is their right and needs no explanation" — so the
   * label has to read as an ordinary row rather than as a gap to be filled.
   */
  it("gets a label rather than a blank", () => {
    const rows = buildRoster([pupil({ sharedName: null })]);

    expect(rows[0]?.label).toBe("Pupil 1");
    expect(rows[0]?.anonymous).toBe(true);
  });

  /**
   * Numbered by position in the finished list, not by when they joined. A
   * label derived from join order would encode a fact about them that nobody
   * agreed to share — and would move when somebody else left.
   */
  it("is numbered by position, not by when they joined", () => {
    const rows = buildRoster([
      pupil({ learnerId: "late", sharedName: null, progress: [attempt("2026-09-14")] }),
      pupil({ learnerId: "early", sharedName: null }),
      pupil({ learnerId: "named", sharedName: "Amara" }),
    ]);

    expect(rows.map((r) => r.label)).toEqual(["Amara", "Pupil 1", "Pupil 2"]);
  });

  /**
   * The class-wide setting overrides what each pupil chose — board 1b offers
   * "Not at all · attendance as a count, nobody named" as a class setting, and
   * a teacher who picks it must not still see the names of pupils who shared
   * one.
   */
  it("is anonymous for everyone when the class is set that way", () => {
    const rows = buildRoster(
      [pupil({ learnerId: "a", sharedName: "Amara" }), pupil({ learnerId: "b", sharedName: "Ben" })],
      "anonymous",
    );

    expect(rows.map((r) => r.label)).toEqual(["Pupil 1", "Pupil 2"]);
    expect(JSON.stringify(rows)).not.toContain("Amara");
  });
});

describe("capture health, which is about a microphone", () => {
  /**
   * The board's line: "Six of Ben's last eight takes came back unusable. That
   * is usually a microphone or a room, not a pupil." It is the R8
   * indeterminate count — takes the product refused to score because it could
   * not hear them — so it says nothing about how anybody spoke.
   */
  it("reports unusable takes against a total", () => {
    const rows = buildRoster([pupil({ sharedName: "Ben", unusableTakes: 6, totalTakes: 8 })]);

    expect(rows[0]?.capture).toEqual({ unusable: 6, total: 8 });
  });

  /**
   * Two bad takes out of two is a ratio of one, and shown to a teacher it
   * reads as a broken microphone when it is a pupil who has practised twice.
   */
  it("says nothing at all below a sample worth reading", () => {
    const rows = buildRoster([
      pupil({ sharedName: "Ben", unusableTakes: 2, totalTakes: MIN_TAKES_FOR_CAPTURE_HEALTH - 1 }),
    ]);

    expect(rows[0]?.capture).toBeNull();
  });

  it("flags a device worth checking, and leaves a healthy one alone", () => {
    const [bad] = buildRoster([pupil({ sharedName: "Ben", unusableTakes: 6, totalTakes: 8 })]);
    const [good] = buildRoster([pupil({ sharedName: "Amara", unusableTakes: 1, totalTakes: 8 })]);

    expect(bad && captureNeedsAttention(bad)).toBe(true);
    expect(good && captureNeedsAttention(good)).toBe(false);
  });

  it("reads the threshold the same way on either side of it", () => {
    const at = Math.ceil(CAPTURE_CONCERN_RATIO * 10);
    const [onIt] = buildRoster([pupil({ sharedName: "A", unusableTakes: at, totalTakes: 10 })]);
    const [under] = buildRoster([pupil({ sharedName: "A", unusableTakes: at - 1, totalTakes: 10 })]);

    expect(onIt && captureNeedsAttention(onIt)).toBe(true);
    expect(under && captureNeedsAttention(under)).toBe(false);
  });

  it("never flags a pupil it has no sample for", () => {
    const [row] = buildRoster([pupil({ sharedName: "Amara" })]);
    expect(row && captureNeedsAttention(row)).toBe(false);
  });
});

describe("attendance", () => {
  it("counts a day once, however many activities were done on it", () => {
    const rows = buildRoster([
      pupil({
        sharedName: "Amara",
        progress: [attempt("2026-09-14"), attempt("2026-09-14"), attempt("2026-09-15")],
      }),
    ]);

    expect(rows[0]?.days).toEqual(["2026-09-15", "2026-09-14"]);
  });

  it("says how long since a pupil last practised", () => {
    const rows = buildRoster([pupil({ sharedName: "Ben", progress: [attempt("2026-09-05")] })]);
    const row = rows[0];

    expect(row && daysSincePractice(row, new Date("2026-09-17T09:00:00.000Z"))).toBe(12);
  });

  it("says nothing rather than zero for a pupil who never has", () => {
    const rows = buildRoster([pupil({ sharedName: "Ben" })]);
    const row = rows[0];

    expect(row && daysSincePractice(row, new Date("2026-09-17T09:00:00.000Z"))).toBeNull();
  });
});
