// @vitest-environment jsdom

/**
 * One sound, opened up.
 *
 * The board's sentence about this screen contains the two properties worth
 * testing: "The distribution is bucketed and unlabelled by pupil, so the shape
 * is readable and no bar leads anywhere." The second half is the one somebody
 * will undo by adding an onClick to a bar, and it is the ranking this whole
 * view exists without.
 */

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { SoundDetail } from "./SoundDetail.js";
import type { SoundDifficulty } from "../teacher/classSummary.js";

afterEach(cleanup);

/** The board's own distribution: 9 / 13 / 6 over a class of 28. */
function difficulty(over: Partial<SoundDifficulty> = {}): SoundDifficulty {
  return {
    grapheme: "ʁ",
    justStarted: 9,
    gettingThere: 13,
    holding: 6,
    working: 22,
    takes: 214,
    notYet: 0,
    ...over,
  };
}

function show(over: Partial<Parameters<typeof SoundDetail>[0]> = {}) {
  render(
    <SoundDetail
      grapheme="ʁ"
      code="fr-FR"
      difficulty={difficulty()}
      joinedCount={28}
      heardIn={["voudrais", "très", "froid"]}
      note={{
        howItIsMade: "Made at the back of the throat, not with the tongue tip.",
        inTheRoom: "Start from a gargle, then shorten it until it is a consonant.",
      }}
      {...over}
    />,
  );
}

describe("no bar leads anywhere", () => {
  /**
   * The property this screen is built around. A drill-through from a bucket is
   * a list of children at a level, which is the ranking the teacher view
   * exists without — so the bars are not controls and the component takes no
   * callback that could make them into one.
   */
  it("renders no interactive element in the distribution", () => {
    show();

    const buckets = document.querySelector(".sound-buckets");
    expect(buckets).not.toBeNull();
    expect(buckets?.querySelectorAll("button, a, [role='button'], [tabindex]")).toHaveLength(0);
  });

  it("names no pupil", () => {
    show();

    // Nothing in the props carries one; this fails if a future shape adds one
    // and this screen renders it.
    expect(document.body.textContent ?? "").not.toMatch(/pupil [A-Za-z0-9-]{6,}/);
  });
});

describe("the shape", () => {
  it("shows the three buckets, named rather than numbered", () => {
    show();

    expect(screen.getByText("Just started")).toBeInTheDocument();
    expect(screen.getByText("Getting there")).toBeInTheDocument();
    expect(screen.getByText("Holding")).toBeInTheDocument();
  });

  /**
   * Written, not only drawn. A bar's length is a second encoding of a figure
   * that is already a word, and colour or size is never the only carrier.
   */
  it("writes each count out, so the bar is not the only carrier", () => {
    show();

    for (const count of ["9", "13", "6"]) {
      expect(screen.getByText(count)).toBeInTheDocument();
    }
  });

  it("scales the bars against the widest bucket, not against the class", () => {
    show();

    const bars = [...document.querySelectorAll(".sound-bucket-bar")] as HTMLElement[];
    // 13 is the widest, so it is full width and 9 is 9/13 of it.
    expect(bars[1]?.style.transform).toBe("scaleX(1)");
    expect(bars[0]?.style.transform).toBe(`scaleX(${9 / 13})`);
  });

  /**
   * The board's example class has every pupil placed, so its three bars sum to
   * the class. A real one does not, and three bars quietly describing 22 of 28
   * pupils would be a distribution of a group the screen never names.
   */
  it("says how many pupils are not in the shape at all", () => {
    show({ difficulty: difficulty({ justStarted: 5, gettingThere: 5, holding: 5, notYet: 13 }) });

    expect(screen.getByText(/15 of 28 pupils have reached this sound/)).toBeInTheDocument();
    expect(screen.getByText(/other 13/)).toBeInTheDocument();
  });

  it("says nothing about it when every pupil has reached the sound", () => {
    show();

    expect(screen.queryByText(/have reached this sound/)).toBeNull();
  });
});

describe("the words and the notes", () => {
  it("marks the words it turns up in as the content language", () => {
    show();

    expect(screen.getByText("voudrais")).toHaveAttribute("lang", "fr-FR");
  });

  it("marks the sound itself as the content language", () => {
    show();

    expect(screen.getByText("ʁ")).toHaveAttribute("lang", "fr-FR");
  });

  /**
   * Teaching notes are content about a sound, the same for every class. The
   * screen says so, because a teacher reading advice on a class screen would
   * otherwise reasonably take it as advice about their class.
   */
  it("says the teaching notes are not about this class", () => {
    show();

    expect(screen.getByText(/the same for every class/i)).toBeInTheDocument();
  });

  it("renders without notes rather than inventing them", () => {
    show({ note: null });

    expect(screen.queryByText(/In the room/)).toBeNull();
    expect(screen.getByText("Just started")).toBeInTheDocument();
  });

  it("omits the words section when the content names none", () => {
    show({ heardIn: [] });

    expect(screen.queryByText(/Where it turns up/)).toBeNull();
  });
});
