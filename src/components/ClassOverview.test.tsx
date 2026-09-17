// @vitest-environment jsdom

/**
 * The teacher's class screen.
 *
 * Most of these assert an absence. The board's rule is that no pronunciation
 * figure about an identified pupil appears anywhere in this view, "which means
 * there is no column to sort, no average to compute, and no ranking to build
 * out of what the teacher is given" — so the tests worth writing are the ones
 * that fail when a route to one appears.
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClassOverview } from "./ClassOverview.js";
import type { ClassSummary, SoundDifficulty } from "../teacher/classSummary.js";
import { forbiddenPathsIn } from "../teacher/promise.js";

afterEach(cleanup);

/**
 * A summary in the shape the server sends, with the board's own numbers: a
 * class of 28, 9 / 13 / 6 on ʁ, and 22 of them still working on it.
 *
 * Built directly rather than by running the aggregator. The aggregator lives
 * on the server and has its own tests; what this file is for is what the
 * screen does with a summary, and a fixture that went through
 * `summariseClass` would make every assertion here depend on two things.
 */
function sound(over: Partial<SoundDifficulty> = {}): SoundDifficulty {
  return {
    grapheme: "ʁ",
    justStarted: 9,
    gettingThere: 13,
    holding: 6,
    takes: 224,
    working: 22,
    notYet: 0,
    ...over,
  };
}

function boardSummary(over: Partial<Extract<ClassSummary, { reportable: true }>> = {}): ClassSummary {
  return {
    reportable: true,
    joinedCount: 28,
    sounds: [sound()],
    attendance: [
      { day: "2026-09-14", practisedCount: 17 },
      { day: "2026-09-15", practisedCount: 19 },
    ],
    ...over,
  };
}

function show(summary: ClassSummary, over: Partial<Parameters<typeof ClassOverview>[0]> = {}) {
  render(
    <ClassOverview
      className="Year 9 French"
      code="fr-FR"
      summary={summary}
      expectedCount={31}
      heardIn={{ "ʁ": ["voudrais", "très", "proche"] }}
      {...over}
    />,
  );
}

describe("what it will not show", () => {
  /**
   * The whole view exists without a ranking, so there must be no control that
   * implies one is coming. A sort control over a single column teaches that a
   * second column exists.
   */
  it("offers no way to sort the class", () => {
    show(boardSummary());

    const headers = screen.getAllByRole("columnheader");
    for (const header of headers) {
      expect(within(header).queryByRole("button")).toBeNull();
      expect(header).not.toHaveAttribute("aria-sort");
    }
  });

  /**
   * The same list the pupil-facing promise is built from, run against the
   * shape this screen is handed. It fails the moment a figure about a named
   * child enters the payload — before any markup could render it.
   */
  it("is handed nothing the promise forbids", () => {
    expect(forbiddenPathsIn(boardSummary())).toEqual([]);
  });

  /**
   * Attendance is a count and a strip — never a column beside a performance
   * figure, which is what the board rules out.
   *
   * Asserted structurally rather than by scanning the text for "score". The
   * screen's own copy explains that it shows no average of anybody's scores,
   * so a word search flags the disclaimer and would have to be loosened until
   * it caught nothing at all.
   */
  it("renders attendance as a list of day counts, not as a table", () => {
    show(boardSummary());

    expect(screen.getByText("Turning up")).toBeInTheDocument();
    const strip = document.querySelector(".class-attendance-strip");
    expect(strip?.tagName).toBe("OL");
    expect(strip?.querySelector("table")).toBeNull();
  });

  /**
   * Four columns, and a fifth would be the one that does not exist. This fails
   * if a score column is ever added beside them.
   */
  it("has exactly the four columns the board names", () => {
    show(boardSummary());

    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Sound",
      "Heard in",
      "How much of the class is still working on it",
      "Takes",
    ]);
  });
});

describe("sound difficulty", () => {
  it("counts pupils, not an average", () => {
    show(boardSummary());

    expect(screen.getByText("22 of 28")).toBeInTheDocument();
  });

  it("shows the words a sound is heard in, marked as the content language", () => {
    show(boardSummary());

    expect(screen.getByText("voudrais · très · proche")).toHaveAttribute("lang", "fr-FR");
  });

  it("shows how many takes the class has made on it", () => {
    show(boardSummary());

    // Twenty-eight pupils at eight takes each.
    expect(screen.getByText("224")).toBeInTheDocument();
  });

  it("leads with the hardest sound as something worth a lesson", () => {
    show(boardSummary());

    expect(screen.getByText(/a class problem, not 22 individual ones/)).toBeInTheDocument();
  });

  it("opens a sound when asked, and only when a handler was given", () => {
    const onOpenSound = vi.fn();
    show(boardSummary(), { onOpenSound });

    screen.getByRole("button", { name: "ʁ" }).click();
    expect(onOpenSound).toHaveBeenCalledWith("ʁ");

    cleanup();
    show(boardSummary());
    expect(screen.queryByRole("button", { name: "ʁ" })).toBeNull();
  });
});

describe("pupils who have not joined", () => {
  /**
   * The board: "Nothing about them appears here, including the fact that they
   * have or have not practised." A count of them is the whole of it.
   */
  it("states how many have not joined and nothing else about them", () => {
    show(boardSummary());

    expect(screen.getByText(/3 pupils have not joined/)).toBeInTheDocument();
  });

  it("says nothing at all when the teacher has not said how many to expect", () => {
    show(boardSummary(), { expectedCount: null });

    expect(screen.queryByText(/have not joined/)).toBeNull();
    expect(screen.getByText(/28 joined/)).toBeInTheDocument();
  });
});

describe("a class too small to describe", () => {
  /**
   * The counts are withheld and the reason is given. An empty difficulty table
   * would be read as "nobody is struggling", which is the opposite of unknown.
   */
  it("explains why there are no counts, rather than showing an empty table", () => {
    show({ reportable: false, joinedCount: 2, reason: "class-too-small" });

    expect(screen.getByText(/too small to describe as a group/i)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("does not leak the sounds it is withholding", () => {
    show({ reportable: false, joinedCount: 1, reason: "class-too-small" });

    expect(document.body.textContent ?? "").not.toContain("ʁ");
  });
});
