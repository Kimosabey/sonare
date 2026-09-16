// @vitest-environment jsdom

/**
 * The pupil's copy of what a class can see.
 *
 * The property worth testing is not the wording — it is that this renders the
 * **same source** as the teacher's limits panel will. Board 1c: the pupil is
 * shown "the same one the teacher was shown, so neither side is told a
 * different story". A second hand-written list here would agree today and
 * drift at the first change, invisibly, because nobody reads both screens at
 * once.
 */

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { ClassPromise } from "./ClassPromise.js";
import { NEVER_SHARED_WITH_CLASS, SHARED_WITH_CLASS } from "../teacher/promise.js";

afterEach(cleanup);

describe("it renders the one list, not a copy of it", () => {
  it("shows every shared fact", () => {
    render(<ClassPromise />);

    for (const fact of SHARED_WITH_CLASS) {
      expect(screen.getByText(fact.label), fact.label).toBeInTheDocument();
    }
  });

  it("shows every withheld fact", () => {
    render(<ClassPromise />);

    for (const fact of NEVER_SHARED_WITH_CLASS) {
      expect(screen.getByText(fact.label), fact.label).toBeInTheDocument();
    }
  });

  /**
   * The reason, not only the label. A learner deciding whether to join is
   * deciding on the reason — "your scores" without "because a class that could
   * see one would sort by it" is a rule rather than an argument.
   */
  it("gives the reason beside each one", () => {
    render(<ClassPromise />);

    for (const fact of [...SHARED_WITH_CLASS, ...NEVER_SHARED_WITH_CLASS]) {
      expect(screen.getByText(fact.because), fact.label).toBeInTheDocument();
    }
  });
});

describe("what it says about switches", () => {
  /**
   * The sentence that makes the list mean something. Without it a learner can
   * reasonably assume the withheld half is a default somebody could change.
   */
  it("says the withheld half is not a setting", () => {
    render(<ClassPromise />);

    expect(screen.getByText(/These are not settings/i)).toBeInTheDocument();
  });
});

describe("before and after joining", () => {
  it("reads as a description of the offer when there is no class", () => {
    render(<ClassPromise />);

    expect(screen.getByRole("heading", { name: /If you join a class/i })).toBeInTheDocument();
    expect(screen.queryByText(/Leaving keeps everything/i)).not.toBeInTheDocument();
  });

  it("names the class and how to leave once there is one", () => {
    render(<ClassPromise className="Year 9 French" />);

    expect(screen.getByRole("heading", { name: /Year 9 French/ })).toBeInTheDocument();
    expect(screen.getByText(/Leaving keeps everything you have learned/i)).toBeInTheDocument();
  });

  it("names the shared name only when one is shared", () => {
    render(<ClassPromise className="Year 9 French" sharedName="Maya" />);
    expect(screen.getByText("Maya")).toBeInTheDocument();
  });

  /**
   * A learner who joined without a name must not read a line implying one is
   * being shared — that is the promise being wrong about itself.
   */
  it("says nothing about a name when none is shared", () => {
    render(<ClassPromise className="Year 9 French" />);

    expect(screen.queryByText(/The name they see/i)).not.toBeInTheDocument();
  });
});
