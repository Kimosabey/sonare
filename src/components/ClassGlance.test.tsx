// @vitest-environment jsdom

/**
 * The class on a phone.
 *
 * The board's limit is "nothing that needs a desk", so most of these check
 * what is *absent*: no table, no buckets, no pupils, and no link inviting a
 * teacher to read any of those in a corridor.
 */

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { ClassGlance } from "./ClassGlance.js";
import type { ClassSummary, SoundDifficulty } from "../teacher/classSummary.js";

afterEach(cleanup);

const THURSDAY = new Date("2026-09-17T09:00:00.000Z");

function sound(over: Partial<SoundDifficulty> = {}): SoundDifficulty {
  return {
    grapheme: "ʁ",
    justStarted: 9,
    gettingThere: 13,
    holding: 6,
    takes: 214,
    working: 22,
    notYet: 0,
    ...over,
  };
}

const SUMMARY: ClassSummary = {
  reportable: true,
  joinedCount: 28,
  sounds: [sound(), sound({ grapheme: "ui", working: 16 })],
  attendance: [
    { day: "2026-09-16", practisedCount: 17 },
    { day: "2026-09-17", practisedCount: 19 },
  ],
};

function show(over: Partial<Parameters<typeof ClassGlance>[0]> = {}) {
  render(
    <ClassGlance
      className="Year 9 French"
      code="fr-FR"
      summary={SUMMARY}
      heardIn={{ "ʁ": ["très", "voudrais", "proche"] }}
      today={THURSDAY}
      {...over}
    />,
  );
}

describe("what is worth a glance", () => {
  it("names the day and the class", () => {
    show();
    expect(screen.getByText("Thursday · Year 9 French")).toBeInTheDocument();
  });

  /**
   * One sound, the hardest, because the board's question is "the one sound to
   * spend five minutes on" — not a ranking a teacher would have to read.
   */
  it("names one sound to spend five minutes on", () => {
    show();

    expect(screen.getByText(/Spend five minutes on/)).toBeInTheDocument();
    expect(screen.getByText("ʁ")).toHaveAttribute("lang", "fr-FR");
    expect(screen.queryByText("ui")).toBeNull();
  });

  it("says how hard it is, as a count", () => {
    show();
    expect(screen.getByText(/Hard for 22 of 28/)).toBeInTheDocument();
  });

  /**
   * Two words, not the whole list. The line is something to say out loud at
   * the front of a room, and a teacher cannot chorus six.
   */
  it("gives two words to chorus, in the content language", () => {
    show();

    expect(screen.getByText("très")).toHaveAttribute("lang", "fr-FR");
    expect(screen.getByText("voudrais")).toHaveAttribute("lang", "fr-FR");
    expect(screen.queryByText("proche")).toBeNull();
  });

  it("reads sensibly when the content names no words for that sound", () => {
    show({ heardIn: {} });

    expect(screen.getByText(/Hard for 22 of 28/)).toBeInTheDocument();
    expect(screen.queryByText(/Chorus/)).toBeNull();
  });

  it("shows attendance as the most recent count", () => {
    show();
    expect(screen.getByText("19 of 28")).toBeInTheDocument();
  });
});

describe("nothing that needs a desk", () => {
  it("renders no table", () => {
    show();
    expect(screen.queryByRole("table")).toBeNull();
  });

  /**
   * No bucket distribution and no pupil names. Both need a desk, and a link to
   * them would be an invitation to read a table in a corridor — which is the
   * thing this screen replaces.
   */
  it("shows no distribution, no pupils, and no way through to either", () => {
    show();

    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/Just started|Getting there|Holding/);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("a class too small to describe", () => {
  it("says so rather than showing a sound with nothing behind it", () => {
    show({ summary: { reportable: false, joinedCount: 2, reason: "class-too-small" } });

    expect(screen.getByText(/Too few pupils have joined/)).toBeInTheDocument();
    expect(screen.queryByText(/Spend five minutes/)).toBeNull();
  });
});
