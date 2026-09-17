// @vitest-environment jsdom

/**
 * How much a screen asks somebody to read, held to a budget.
 *
 * This exists because of a measurement rather than a feeling. The pupil's join
 * screen — a consent decision, on a 360px phone — rendered **171 words**: six
 * facts each with a justification underneath, about three scrolls before the
 * two buttons the pupil came to press. Nothing failed. It typechecked, every
 * assertion passed, and the board it was built from carries the labels alone.
 *
 * Copy grows the way that kind of thing always grows: one clarifying sentence
 * at a time, each of them defensible on its own. So the budget is per screen
 * and the numbers are deliberately unequal, because the screens have different
 * jobs:
 *
 * - A **decision** taken on a phone is scanned under a thumb. It gets less
 *   room than the screens carrying the same facts at a desk. Not the tightest
 *   budget in the product — the sound detail is a chart with almost no prose
 *   and is rightly tighter still.
 * - A **reference** panel is read at leisure and may be complete. The You
 *   tab's copy of the class promise keeps its reasons for exactly that reason,
 *   and `ClassPromise.test.tsx` asserts they are there.
 * - An **operator** screen at 1280 is read at a desk, by somebody whose job
 *   this is, usually once before an irreversible action.
 *
 * The budgets are ceilings with room, not targets. They exist to fail when a
 * screen doubles, not to shave a sentence.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JoinClass } from "./JoinClass.js";
import { ClassLimits } from "./ClassLimits.js";
import { ClassOverview } from "./ClassOverview.js";
import { SoundDetail } from "./SoundDetail.js";
import { PublishDiff } from "./PublishDiff.js";
import type { ClassSummary, SoundDifficulty } from "../teacher/classSummary.js";

afterEach(cleanup);

const sound: SoundDifficulty = {
  grapheme: "ʁ",
  justStarted: 9,
  gettingThere: 13,
  holding: 6,
  takes: 224,
  working: 22,
  notYet: 0,
};

const summary: ClassSummary = {
  reportable: true,
  joinedCount: 28,
  sounds: [sound],
  attendance: [{ day: "2026-09-15", practisedCount: 19 }],
};

/** Words a reader actually meets, from the rendered text rather than the source. */
function wordsRendered(): number {
  return (document.body.textContent ?? "").trim().split(/\s+/).filter(Boolean).length;
}

interface Budget {
  name: string;
  /** Why this screen gets this number. */
  because: string;
  ceiling: number;
  render: () => void;
}

const BUDGETS: Budget[] = [
  {
    name: "the pupil's join decision",
    because: "a consent decision, on a 360px phone, scanned under a thumb",
    ceiling: 110,
    render: () =>
      void render(
        <JoinClass
          className="Year 9 French"
          teacherName="Mr Okonjo"
          learnerName="Maya"
          onJoin={vi.fn()}
          onDecline={vi.fn()}
        />,
      ),
  },
  {
    name: "the teacher's first run",
    because:
      "read once at a desk, and it has to answer the gradebook question fully enough that nobody goes looking for one",
    ceiling: 200,
    render: () => void render(<ClassLimits />),
  },
  {
    name: "the teacher's limits page",
    because: "reference material, consulted rather than read through",
    ceiling: 280,
    render: () => void render(<ClassLimits showCapabilities />),
  },
  {
    name: "the class overview",
    because: "an operator dashboard at 1280; the table is the content",
    ceiling: 130,
    render: () =>
      void render(
        <ClassOverview
          className="Year 9 French"
          code="fr-FR"
          summary={summary}
          expectedCount={31}
          heardIn={{ "ʁ": ["voudrais"] }}
        />,
      ),
  },
  {
    name: "one sound, opened up",
    because: "a shape to read, not a page; the distribution is the content",
    ceiling: 90,
    render: () =>
      void render(
        <SoundDetail
          grapheme="ʁ"
          code="fr-FR"
          difficulty={sound}
          joinedCount={28}
          heardIn={["voudrais"]}
          note={{
            howItIsMade: "Made at the back of the throat, not with the tongue tip.",
            inTheRoom: "Start from a gargle, then shorten it until it is a consonant.",
          }}
        />,
      ),
  },
  {
    name: "the publish diff",
    because: "read once before an irreversible action, by somebody whose job it is",
    ceiling: 170,
    render: () =>
      void render(
        <PublishDiff
          label="French"
          code="fr-FR"
          fromVersion={7}
          toVersion={8}
          changes={[]}
          reach={new Map()}
          onPublish={vi.fn()}
          onBack={vi.fn()}
        />,
      ),
  },
];

describe("how much each screen asks somebody to read", () => {
  for (const budget of BUDGETS) {
    it(`${budget.name} stays under ${budget.ceiling} words — ${budget.because}`, () => {
      budget.render();
      const words = wordsRendered();

      expect(
        words,
        `${budget.name} renders ${words} words against a ceiling of ${budget.ceiling}`,
      ).toBeLessThanOrEqual(budget.ceiling);
    });
  }

  /**
   * Non-vacuity. Without this the whole file would pass just as happily if
   * `wordsRendered` returned zero — which is the shape of mistake that let a
   * 171-word consent screen ship in the first place.
   */
  it("actually counts the words on the page", () => {
    render(
      <SoundDetail grapheme="ʁ" code="fr-FR" difficulty={sound} joinedCount={28} />,
    );

    expect(wordsRendered()).toBeGreaterThan(5);
  });

  /**
   * The same facts, budgeted differently by who is reading them and where.
   *
   * Stated against the two screens that carry *the same promise* rather than
   * against every screen — an earlier version claimed the phone decision had
   * the tightest budget in the product, which is false and should be: the
   * sound detail is a chart with almost no prose and is rightly tighter still.
   * The property that matters is that the same six facts get less room on a
   * phone, under a thumb, in the moment of deciding.
   */
  it("gives the same facts less room on the phone than at a desk", () => {
    const ceilingOf = (name: string): number =>
      BUDGETS.find((b) => b.name === name)?.ceiling ?? Number.NaN;

    const decision = ceilingOf("the pupil's join decision");
    expect(Number.isNaN(decision)).toBe(false);

    for (const desk of ["the teacher's first run", "the teacher's limits page"]) {
      expect(decision, `${desk} should have more room than the phone`).toBeLessThan(
        ceilingOf(desk),
      );
    }
  });
});
