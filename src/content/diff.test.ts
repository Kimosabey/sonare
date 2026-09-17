/**
 * What a publish does to people who have already practised.
 *
 * The board this comes from is explicit that the screen is "not a gate, it is
 * making one irreversible case visible", so the tests worth writing are not
 * "does it notice an edit" — they are the ones that separate an edit a learner
 * will never feel from an edit that silently detaches their history.
 */

import { describe, expect, it } from "vitest";
import { diffContent, consequentialChanges } from "./diff.js";
import type { Activity, LanguageActivitySet } from "../activities/types.js";

function activity(id: number, over: Partial<Activity> = {}): Activity {
  return {
    id,
    title: `Activity ${id}`,
    kind: "repeat",
    prompt: `Say phrase ${id}`,
    gloss: `Phrase ${id}`,
    target: `Phrase ${id}`,
    focus: `focus ${id}`,
    soundTargets: [`syl${id}`],
    ...over,
  };
}

/** A set with a spine, so locations resolve. */
function set(activities: Activity[]): LanguageActivitySet {
  return {
    code: "fr-FR",
    slug: "fr",
    label: "French",
    activities,
    units: [
      {
        id: 1,
        title: "Ordering",
        outcome: "You can order food and be understood.",
        lessons: [
          {
            id: 1,
            title: "At the counter",
            outcome: "You can ask for what you want.",
            activityIds: activities.map((a) => a.id),
          },
        ],
      },
    ],
  };
}

describe("what changed", () => {
  it("reports nothing when nothing moved", () => {
    const before = set([activity(1), activity(2)]);
    expect(diffContent(before, set([activity(1), activity(2)]))).toEqual([]);
  });

  it("reports an added activity", () => {
    const changes = diffContent(set([activity(1)]), set([activity(1), activity(2)]));
    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe("added");
    expect(changes[0]?.activityId).toBe(2);
  });

  it("reports a removed activity", () => {
    const changes = diffContent(set([activity(1), activity(2)]), set([activity(1)]));
    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe("removed");
    expect(changes[0]?.activityId).toBe(2);
  });

  it("reports a changed field with both sides, so the panel can show the edit", () => {
    const changes = diffContent(
      set([activity(1, { gloss: "The fish" })]),
      set([activity(1, { gloss: "The poison" })]),
    );

    expect(changes).toHaveLength(1);
    const change = changes[0];
    expect(change?.kind).toBe("changed");
    if (change?.kind !== "changed") throw new Error("expected a changed entry");
    expect(change.field).toBe("gloss");
    expect(change.before).toBe("The fish");
    expect(change.after).toBe("The poison");
  });

  it("reports each edited field separately rather than one entry per activity", () => {
    const changes = diffContent(
      set([activity(1)]),
      set([activity(1, { gloss: "new gloss", focus: "new focus" })]),
    );

    expect(changes.map((c) => (c.kind === "changed" ? c.field : c.kind)).sort()).toEqual([
      "focus",
      "gloss",
    ]);
  });
});

describe("the edit that re-keys a learner's sound history", () => {
  /**
   * The distinction the whole file exists for. The syllables an activity
   * measures are derived from its phrase, so changing `target` detaches the
   * history that activity has been feeding — the old syllables stay in the
   * store attached to nothing and the new ones start from none.
   */
  it("flags a changed target", () => {
    const changes = diffContent(
      set([activity(1, { target: "le poisson" })]),
      set([activity(1, { target: "le poison" })]),
    );

    const change = changes[0];
    if (change?.kind !== "changed") throw new Error("expected a changed entry");
    expect(change.field).toBe("target");
    expect(change.reKeysSoundHistory).toBe(true);
  });

  /**
   * The other half, and the half that makes the flag mean something. If every
   * change carried it, an author would learn to click past the warning and the
   * one edit in fifty that matters would go with it.
   */
  it("does not flag any other field", () => {
    const fields: Array<Partial<Activity>> = [
      { title: "new" },
      { kind: "read" },
      { prompt: "new" },
      { gloss: "new" },
      { focus: "new" },
      { soundTargets: ["other"] },
    ];

    for (const edit of fields) {
      const changes = diffContent(set([activity(1)]), set([activity(1, edit)]));
      expect(changes.length).toBeGreaterThan(0);
      for (const change of changes) {
        if (change.kind !== "changed") continue;
        expect(change.reKeysSoundHistory).toBe(false);
      }
    }
  });

  /**
   * Editing the target list changes which syllables the *scheduler* weighs. It
   * does not change what the scorer returns, which comes from the phrase — so
   * the history keeps matching, and calling this a re-key would be a lie in
   * the more alarming direction.
   */
  it("does not flag an edited sound-target list", () => {
    const changes = diffContent(
      set([activity(1, { soundTargets: ["poi", "sson"] })]),
      set([activity(1, { soundTargets: ["poi"] })]),
    );

    const change = changes[0];
    if (change?.kind !== "changed") throw new Error("expected a changed entry");
    expect(change.field).toBe("soundTargets");
    expect(change.reKeysSoundHistory).toBe(false);
  });

  /**
   * Both directions, and the second one is not redundant.
   *
   * The comparison sorts each side independently, so a version of this that
   * sorted only one of them would still pass a single case whose "before" list
   * happened to be alphabetical already — and would then report a spurious
   * change for every activity whose authored order is not. Starting from an
   * unsorted list is what makes the assertion bite.
   */
  it("says nothing when sound targets are only reordered", () => {
    for (const [was, now] of [
      [["poi", "sson"], ["sson", "poi"]],
      [["sson", "poi"], ["poi", "sson"]],
    ]) {
      const changes = diffContent(
        set([activity(1, { soundTargets: was })]),
        set([activity(1, { soundTargets: now })]),
      );

      expect(changes).toEqual([]);
    }
  });
});

describe("where a change happened", () => {
  /**
   * A removed activity exists only in the old version, so its location has to
   * be resolved there. Looking it up in the new one returns nulls and the
   * screen cannot say which lesson just got shorter — which is the single
   * most useful thing it could say about a removal.
   */
  it("locates a removed activity in the version that still contains it", () => {
    const changes = diffContent(set([activity(1), activity(2)]), set([activity(1)]));

    const change = changes[0];
    if (change?.kind !== "removed") throw new Error("expected a removed entry");
    expect(change.where.lessonTitle).toBe("At the counter");
    expect(change.where.unitTitle).toBe("Ordering");
  });

  it("locates an added activity in the version that introduces it", () => {
    const changes = diffContent(set([activity(1)]), set([activity(1), activity(2)]));

    const change = changes[0];
    if (change?.kind !== "added") throw new Error("expected an added entry");
    expect(change.where.lessonTitle).toBe("At the counter");
  });

  /**
   * A flat set is still valid published content — it is the shape that shipped
   * before the spine existed. Diffing one must describe the change rather than
   * throw on the missing structure.
   */
  it("describes a change in a set with no spine", () => {
    const flat = (a: Activity[]): LanguageActivitySet => ({
      code: "fr-FR",
      slug: "fr",
      label: "French",
      activities: a,
    });

    const changes = diffContent(flat([activity(1)]), flat([activity(1, { gloss: "new" })]));

    expect(changes).toHaveLength(1);
    expect(changes[0]?.where.lessonTitle).toBeNull();
  });
});

describe("the order the screen reads in", () => {
  /**
   * Added, then changed, then removed — increasing consequence, so the panel
   * reads top to bottom and so does the risk. Sorting by activity id instead
   * would scatter the removals through the list.
   */
  it("puts additions first and removals last", () => {
    const before = set([activity(1), activity(2)]);
    const after = set([activity(1, { gloss: "edited" }), activity(3)]);

    expect(diffContent(before, after).map((c) => c.kind)).toEqual([
      "added",
      "changed",
      "removed",
    ]);
  });
});

describe("what a learner will actually notice", () => {
  it("keeps removals and re-keys, and drops cosmetic edits", () => {
    const before = set([activity(1, { target: "le poisson" }), activity(2), activity(3)]);
    const after = set([
      activity(1, { target: "le poison" }),
      activity(2, { gloss: "tidied wording" }),
      activity(4),
    ]);

    const consequential = consequentialChanges(diffContent(before, after));

    expect(consequential).toHaveLength(2);
    expect(consequential.map((c) => c.activityId).sort()).toEqual([1, 3]);
  });

  it("is empty for a publish of pure copy edits", () => {
    const before = set([activity(1), activity(2)]);
    const after = set([activity(1, { gloss: "clearer" }), activity(2, { focus: "clearer" })]);

    expect(diffContent(before, after).length).toBe(2);
    expect(consequentialChanges(diffContent(before, after))).toEqual([]);
  });
});

describe("purity", () => {
  it("does not mutate either version", () => {
    const before = set([activity(1, { soundTargets: ["b", "a"] }), activity(2)]);
    const after = set([activity(1, { soundTargets: ["a", "b"] })]);

    const beforeJson = JSON.stringify(before);
    const afterJson = JSON.stringify(after);

    diffContent(before, after);

    // The sound-target comparison sorts. Sorting in place would reorder an
    // author's list underneath them between the preview and the publish.
    expect(JSON.stringify(before)).toBe(beforeJson);
    expect(JSON.stringify(after)).toBe(afterJson);
  });
});
