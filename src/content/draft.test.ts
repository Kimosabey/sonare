/**
 * The client's copy of the publish rules.
 *
 * It exists so an author is told *which field* is wrong before spending a round
 * trip, and so the publish button can be disabled rather than inviting a
 * failure. The server is still the gate: `contentProblems` in
 * server/store/content.ts is what actually refuses a publish, and the screen
 * renders the server's own `problems` verbatim on a 422.
 *
 * That asymmetry is what these tests are built around. This check being
 * *stricter* than the server costs a publish that would have worked, which is
 * an annoyance. This check being *looser* would put a set the server refuses
 * in front of somebody who was told it was fine — so every rule the server
 * holds is asserted here too.
 *
 * The tie to reality is the last block: every set the app ships must pass this
 * check unchanged. Those four sets are what `npm run seed-content` publishes
 * and what src/activities/languages/languages.test.ts already vouches for, so
 * a rule invented here that the bundle would fail is a rule that is wrong.
 */

import { describe, expect, it } from "vitest";
import { LANGUAGES } from "../activities/languages/index.js";
import {
  DRAFT_KINDS,
  MAX_DRAFT_ACTIVITIES,
  MAX_DRAFT_TARGET_WORDS,
  draftFromSet,
  draftProblems,
  draftToPayload,
  emptyActivity,
  type ContentDraft,
  type DraftActivity,
} from "./draft.js";

function activity(over: Partial<DraftActivity> = {}): DraftActivity {
  return {
    id: "1",
    title: "Greeting",
    kind: "repeat",
    prompt: "Say hello",
    gloss: "hello",
    target: "Bonjour",
    focus: "the French r",
    ...over,
  };
}

function draft(over: Partial<ContentDraft> = {}): ContentDraft {
  return {
    slug: "fr",
    code: "fr-FR",
    label: "French",
    activities: [activity()],
    ...over,
  };
}

describe("a draft that is ready", () => {
  it("has nothing to say about a well-formed set", () => {
    expect(draftProblems(draft())).toEqual([]);
  });

  it("accepts every kind the UI can render", () => {
    for (const kind of DRAFT_KINDS) {
      expect(draftProblems(draft({ activities: [activity({ kind })] }))).toEqual([]);
    }
  });
});

describe("refusing what the server would refuse", () => {
  it.each([
    ["a bad slug", { slug: "FR" }, /slug/],
    ["a slug of one letter", { slug: "f" }, /slug/],
    ["a locale the provider will reject", { code: "french" }, /locale/],
    ["an empty locale", { code: "" }, /locale/],
    ["a label of only whitespace", { label: "   " }, /label/],
    ["no activities at all", { activities: [] }, /at least one activity/],
  ])("refuses %s", (_label, over, expected) => {
    const problems = draftProblems(draft(over));

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(" | ")).toMatch(expected);
  });

  it.each([
    ["no target to score against", { target: "" }, /target cannot be empty/],
    ["a target of only whitespace", { target: "   " }, /target cannot be empty/],
    ["no instruction", { prompt: "" }, /prompt cannot be empty/],
    ["no gloss", { gloss: " " }, /gloss cannot be empty/],
    ["no focus", { focus: "" }, /focus cannot be empty/],
    ["no title", { title: "" }, /title cannot be empty/],
    ["a kind the UI cannot render", { kind: "sing" }, /kind must be one of/],
    ["no kind", { kind: "" }, /kind must be one of/],
    ["an unfinished id", { id: "" }, /whole number/],
    ["a fractional id", { id: "1.5" }, /whole number/],
    ["an id of zero", { id: "0" }, /whole number/],
    ["an id that is not a number", { id: "one" }, /whole number/],
  ])("refuses an activity with %s", (_label, over, expected) => {
    const problems = draftProblems(draft({ activities: [activity(over)] }));

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(" | ")).toMatch(expected);
  });

  it("refuses a duplicate id, which would merge two activities' attempts", () => {
    // `id` is the React key, the progress key and what the report joins on: a
    // learner who passes one row would appear to have passed the other.
    const problems = draftProblems(
      draft({ activities: [activity({ id: "1" }), activity({ id: "1", target: "Bonsoir" })] }),
    );

    expect(problems.join(" | ")).toMatch(/id 1 is already used/);
  });

  it("refuses a duplicate target, which would score the same phrase twice", () => {
    const problems = draftProblems(
      draft({ activities: [activity({ id: "1" }), activity({ id: "2" })] }),
    );

    expect(problems.join(" | ")).toMatch(/repeats an earlier/);
  });

  it("ignores surrounding whitespace when comparing targets", () => {
    // Otherwise a pasted trailing space is enough to slip a duplicate past a
    // rule whose whole job is catching duplicates.
    const problems = draftProblems(
      draft({ activities: [activity({ id: "1" }), activity({ id: "2", target: " Bonjour " })] }),
    );

    expect(problems.join(" | ")).toMatch(/repeats an earlier/);
  });

  it("refuses a target longer than the capture ceiling", () => {
    /**
     * Past this the phrase is cut off mid-sentence by the capture duration
     * limit and the missing half is scored as an omission — the learner blamed
     * for our timing. Not a style rule.
     */
    const target = Array.from({ length: MAX_DRAFT_TARGET_WORDS + 1 }, (_, i) => `mot${i}`).join(" ");
    const problems = draftProblems(draft({ activities: [activity({ target })] }));

    expect(problems.join(" | ")).toMatch(/cut off mid-phrase/);
  });

  it("accepts a target of exactly the ceiling", () => {
    const target = Array.from({ length: MAX_DRAFT_TARGET_WORDS }, (_, i) => `mot${i}`).join(" ");

    expect(draftProblems(draft({ activities: [activity({ target })] }))).toEqual([]);
  });

  it("refuses more activities than a document should hold", () => {
    const activities = Array.from({ length: MAX_DRAFT_ACTIVITIES + 1 }, (_, i) =>
      activity({ id: String(i + 1), target: `phrase ${i}` }),
    );

    expect(draftProblems(draft({ activities })).join(" | ")).toMatch(/cannot hold more than/);
  });
});

describe("saying where the problem is", () => {
  it("numbers activities from one, matching what is on screen", () => {
    const activities = [activity({ id: "1" }), activity({ id: "2", target: "" })];

    expect(draftProblems(draft({ activities }))).toEqual(["activity 2: target cannot be empty"]);
  });

  it("reports every problem rather than stopping at the first", () => {
    /**
     * A check that reports one thing at a time turns a ten-field form into ten
     * round trips of guessing. Every one of these is fixable in one pass.
     */
    const problems = draftProblems(
      draft({ code: "nope", activities: [activity({ target: "", focus: "", kind: "sing" })] }),
    );

    expect(problems).toHaveLength(4);
  });

  it("lists a blank new row's fields rather than looking ready", () => {
    // The normal state of a half-typed draft, and it must not read as
    // publishable — an empty activity is scoring speech against nothing.
    const problems = draftProblems(draft({ activities: [emptyActivity(1)] }));

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((p) => p.startsWith("activity 1:"))).toBe(true);
  });
});

describe("the wire shape", () => {
  it("sends numbers as numbers and trims what was pasted", () => {
    const payload = draftToPayload(
      draft({ label: " French ", activities: [activity({ id: " 2 ", target: " Bonjour " })] }),
      3,
    );

    expect(payload.baseVersion).toBe(3);
    expect(payload.label).toBe("French");
    expect(payload.activities[0]?.id).toBe(2);
    expect(payload.activities[0]?.target).toBe("Bonjour");
  });

  it("does not send the slug", () => {
    /**
     * It comes from the path. Two sources for one value is a way to publish
     * French content under the Spanish slug, and the path is the one the server
     * already checks.
     */
    expect(Object.keys(draftToPayload(draft(), 0)).sort()).toEqual([
      "activities",
      "baseVersion",
      "code",
      "label",
    ]);
  });
});

describe("seeding a draft", () => {
  it("round-trips a set without changing it", () => {
    const french = LANGUAGES[0];
    if (french === undefined) throw new Error("need a language");

    const payload = draftToPayload(draftFromSet(french), 0);

    expect(payload.activities).toEqual(
      french.activities.map((a) => ({
        id: a.id,
        title: a.title,
        kind: a.kind,
        prompt: a.prompt,
        gloss: a.gloss,
        target: a.target,
        focus: a.focus,
      })),
    );
  });

  it.each(LANGUAGES.map((l) => [l.label, l] as const))(
    "considers the bundled %s set publishable as it stands",
    (_label, set) => {
      /**
       * The tie between this mirror and reality. These four sets are what
       * `seed-content` publishes and what languages.test.ts vouches for, so a
       * rule here that the bundle fails is a rule that is wrong — and "start
       * from the bundled set" would open with a list of problems in content
       * every learner is already using.
       */
      expect(draftProblems(draftFromSet(set))).toEqual([]);
    },
  );
});
