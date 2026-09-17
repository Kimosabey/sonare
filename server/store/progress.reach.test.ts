/**
 * Counting the learners a removal reaches.
 *
 * The number this produces is the one sentence on the publish diff that can
 * talk an operator out of an irreversible publish, so the tests are about the
 * two ways it could be wrong in the direction that makes a removal look safe:
 * counting the wrong learners, or counting none.
 *
 * The fake database **interprets** the aggregation rather than recording it.
 * Asserting that the pipeline contains the stages this file writes would only
 * restate the source; running it over documents asserts the count, which is
 * what the screen shows and what a wrong predicate would change.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Entry {
  activityId: number;
  attemptsUsed: number;
}

interface Doc {
  _id: string;
  learnerId: string;
  slug: string;
  entries: Entry[];
}

let docs: Doc[] = [];
let getDbCalls = 0;

/** Only the stage forms this query actually uses. Anything else throws. */
function runPipeline(stages: Record<string, unknown>[]): Record<string, unknown>[] {
  let rows: Record<string, unknown>[] = docs.map((d) => ({ ...d }) as Record<string, unknown>);

  for (const stage of stages) {
    const [name, spec] = Object.entries(stage)[0] as [string, Record<string, unknown>];

    if (name === "$match") {
      rows = rows.filter((row) =>
        Object.entries(spec).every(([field, condition]) => {
          const value = field.split(".").reduce<unknown>(
            (acc, key) => (acc as Record<string, unknown> | undefined)?.[key],
            row,
          );
          if (condition !== null && typeof condition === "object") {
            const test = condition as { $in?: unknown[]; $gt?: number };
            if (test.$in !== undefined && !test.$in.includes(value)) return false;
            if (test.$gt !== undefined && !(typeof value === "number" && value > test.$gt)) {
              return false;
            }
            return true;
          }
          return value === condition;
        }),
      );
      continue;
    }

    if (name === "$unwind") {
      const field = String(spec).replace(/^\$/, "");
      rows = rows.flatMap((row) =>
        ((row[field] as unknown[]) ?? []).map((item) => ({ ...row, [field]: item })),
      );
      continue;
    }

    if (name === "$group") {
      const idPath = String(spec._id).replace(/^\$/, "").split(".");
      const [outName, accumulator] = Object.entries(spec).filter(([k]) => k !== "_id")[0] as [
        string,
        { $addToSet?: string },
      ];
      const source = String(accumulator.$addToSet).replace(/^\$/, "");
      const groups = new Map<unknown, Set<unknown>>();
      for (const row of rows) {
        const key = idPath.reduce<unknown>(
          (acc, part) => (acc as Record<string, unknown> | undefined)?.[part],
          row,
        );
        const set = groups.get(key) ?? new Set();
        set.add(row[source]);
        groups.set(key, set);
      }
      rows = [...groups].map(([key, set]) => ({ _id: key, [outName]: [...set] }));
      continue;
    }

    if (name === "$project") {
      const [outName, expression] = Object.entries(spec)[0] as [string, { $size?: string }];
      const source = String(expression.$size).replace(/^\$/, "");
      rows = rows.map((row) => ({ _id: row._id, [outName]: (row[source] as unknown[]).length }));
      continue;
    }

    throw new Error(`unsupported stage ${name}`);
  }

  return rows;
}

vi.mock("../db.js", () => ({
  getDb: () => {
    getDbCalls += 1;
    return Promise.resolve({
      collection: () => ({
        aggregate: (stages: Record<string, unknown>[]) => ({
          toArray: () => Promise.resolve(runPipeline(stages)),
        }),
      }),
    });
  },
}));

const { countLearnersWithAttempts } = await import("./progress.js");

function doc(learnerId: string, slug: string, entries: Entry[]): Doc {
  return { _id: `${learnerId}:${slug}`, learnerId, slug, entries };
}

beforeEach(() => {
  docs = [];
  getDbCalls = 0;
});

describe("who has practised an activity", () => {
  it("counts one learner per learner, not one per attempt", async () => {
    docs = [
      doc("a", "fr", [{ activityId: 4, attemptsUsed: 3 }]),
      doc("b", "fr", [{ activityId: 4, attemptsUsed: 1 }]),
    ];

    expect(await countLearnersWithAttempts("fr", [4])).toEqual(new Map([[4, 2]]));
  });

  /**
   * The predicate that decides whether the warning is believable.
   *
   * A progress entry is written when an activity is *offered*, so counting
   * rows would report every learner it was ever scheduled for. That is a much
   * larger number than the one an operator is being asked to weigh, and it is
   * wrong in the direction that trains them to dismiss it.
   */
  it("ignores a learner who was offered the activity but never attempted it", async () => {
    docs = [
      doc("a", "fr", [{ activityId: 4, attemptsUsed: 2 }]),
      doc("b", "fr", [{ activityId: 4, attemptsUsed: 0 }]),
    ];

    expect(await countLearnersWithAttempts("fr", [4])).toEqual(new Map([[4, 1]]));
  });

  it("counts each activity separately", async () => {
    docs = [
      doc("a", "fr", [
        { activityId: 4, attemptsUsed: 1 },
        { activityId: 7, attemptsUsed: 1 },
      ]),
      doc("b", "fr", [{ activityId: 7, attemptsUsed: 1 }]),
    ];

    expect(await countLearnersWithAttempts("fr", [4, 7])).toEqual(
      new Map([
        [4, 1],
        [7, 2],
      ]),
    );
  });

  /**
   * Absent, not zero. The route hands that distinction to the screen, which
   * says "no learner has practised this" only when it has actually been told
   * so — see `content.reach.test.ts`.
   */
  it("omits an activity nobody has attempted", async () => {
    docs = [doc("a", "fr", [{ activityId: 4, attemptsUsed: 1 }])];

    const counts = await countLearnersWithAttempts("fr", [4, 7]);

    expect(counts.get(7)).toBeUndefined();
    expect(counts.has(7)).toBe(false);
  });

  /**
   * Activity ids are unique per language, not globally, so a count that
   * crossed languages would attribute Spanish practice to a French removal.
   */
  it("does not count practice from another language", async () => {
    docs = [
      doc("a", "fr", [{ activityId: 4, attemptsUsed: 1 }]),
      doc("b", "es", [{ activityId: 4, attemptsUsed: 9 }]),
    ];

    expect(await countLearnersWithAttempts("fr", [4])).toEqual(new Map([[4, 1]]));
  });

  it("does not count an activity that was not asked about", async () => {
    docs = [
      doc("a", "fr", [
        { activityId: 4, attemptsUsed: 1 },
        { activityId: 9, attemptsUsed: 1 },
      ]),
    ];

    const counts = await countLearnersWithAttempts("fr", [4]);

    expect([...counts.keys()]).toEqual([4]);
  });

  /**
   * The ordinary publish removes nothing, so this runs with an empty list far
   * more often than not. Opening a connection to ask about nothing would put a
   * database round trip behind every keystroke the diff redraws on.
   */
  it("asks the database nothing when no activity is being removed", async () => {
    docs = [doc("a", "fr", [{ activityId: 4, attemptsUsed: 1 }])];

    expect(await countLearnersWithAttempts("fr", [])).toEqual(new Map());
    expect(getDbCalls).toBe(0);
  });
});
