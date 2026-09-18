// @vitest-environment jsdom

/**
 * The pupil's half of a suggestion.
 *
 * Every test here is a way this could quietly become the deadline board 1f
 * refuses: a countdown, a badge, a date rendered from a phrase, or a prompt
 * with no person behind it.
 */

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { SuggestedSitting } from "./SuggestedSitting.js";

afterEach(cleanup);

function show(over: Partial<Parameters<typeof SuggestedSitting>[0]> = {}) {
  render(
    <MemoryRouter>
      <SuggestedSitting
        className="Year 9 French"
        teacherName="Mr Okonjo"
        slug="fr"
        lessonTitle="Ordering food · Lesson 2"
        window="this-week"
        {...over}
      />
    </MemoryRouter>,
  );
}

describe("it cannot read as a deadline", () => {
  it("shows the teacher's phrase, not a date", () => {
    show({ window: "this-week" });

    expect(screen.getByText(/this week/)).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toMatch(/\d+ days? left|due|overdue|by \d/i);
  });

  it("says 'whenever you like' rather than dropping the open window", () => {
    show({ window: "no-particular-time" });

    expect(screen.getByText(/whenever you like/)).toBeInTheDocument();
  });

  /**
   * A window this build does not recognise can only come from a newer writer.
   * Printed raw it reads as a date — "for next-tuesday" — which is the one
   * thing this must never become.
   */
  it("drops a window it does not recognise rather than printing it raw", () => {
    show({ window: "by-2026-09-20" });

    expect(document.body.textContent ?? "").not.toContain("2026-09-20");
    expect(screen.getByText(/Ordering food/)).toBeInTheDocument();
  });

  it("says in full what a pupil may do instead", () => {
    show();

    expect(screen.getByText(/Do it late, do part of it, or skip it/)).toBeInTheDocument();
    expect(screen.getByText(/nobody is told how it went/)).toBeInTheDocument();
  });
});

describe("who asked", () => {
  /**
   * A prompt from nowhere is an instruction. A prompt from a named teacher is
   * a person asking, which is the thing a pupil can weigh.
   */
  it("names the teacher and the class", () => {
    show();

    expect(screen.getByText("A suggestion from Mr Okonjo")).toBeInTheDocument();
    expect(screen.getByText(/Year 9 French/)).toBeInTheDocument();
  });
});

describe("getting to it", () => {
  it("links into the language rather than locking a lesson", () => {
    show();

    expect(screen.getByRole("link", { name: "Start it" })).toHaveAttribute("href", "/fr");
  });

  it("still reads sensibly when the lesson title could not be resolved", () => {
    show({ lessonTitle: null });

    expect(screen.getByText(/A sitting, for Year 9 French/)).toBeInTheDocument();
  });
});
