// @vitest-environment jsdom

/**
 * The limits screen, and the promise it renders.
 *
 * The board puts this first "because a teacher who expects a gradebook and
 * finds none will otherwise spend a week looking for it". So the tests are
 * about the two ways it could fail to do that job: by not saying what is
 * withheld, and by saying something the pupil's copy of the same promise does
 * not.
 */

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { ClassLimits } from "./ClassLimits.js";
import {
  CLASS_CAPABILITIES,
  TEACHER_WILL_NOT_SEE,
  TEACHER_WILL_SEE,
} from "../teacher/promise.js";

afterEach(cleanup);

describe("both lists are rendered whole", () => {
  it("shows every fact a teacher will see", () => {
    render(<ClassLimits />);

    for (const fact of TEACHER_WILL_SEE) {
      expect(screen.getByText(fact.label)).toBeInTheDocument();
    }
  });

  /**
   * The half that matters. A limits screen that lists what you get and
   * summarises what you do not is a screen that will be read as a feature
   * list, and the absence is the design.
   */
  it("shows every fact a teacher will not see, with the reason", () => {
    render(<ClassLimits />);

    for (const fact of TEACHER_WILL_NOT_SEE) {
      expect(screen.getByText(fact.label)).toBeInTheDocument();
      expect(screen.getByText(fact.because)).toBeInTheDocument();
    }
  });

  it("answers why there is no per-pupil figure rather than leaving it open", () => {
    render(<ClassLimits />);

    expect(screen.getByText(/could do real harm/)).toBeInTheDocument();
    expect(screen.getByText(/not a missing feature, it is the design/)).toBeInTheDocument();
  });
});

describe("the capability table", () => {
  it("is off by default, so the first run is the promise and nothing else", () => {
    render(<ClassLimits />);

    expect(screen.queryByRole("table")).toBeNull();
  });

  it("answers every question a teacher arrives with", () => {
    render(<ClassLimits showCapabilities />);

    for (const capability of CLASS_CAPABILITIES) {
      expect(screen.getByText(capability.request)).toBeInTheDocument();
      expect(screen.getByText(capability.answer)).toBeInTheDocument();
    }
  });

  /**
   * The word, not only a tick. "No — it is not stored against a class" is a
   * different answer from "No — you lack permission", and only one of them is
   * true; a glyph says neither.
   */
  it("writes yes or no as a word", () => {
    render(<ClassLimits showCapabilities />);

    const allowed = CLASS_CAPABILITIES.filter((c) => c.allowed).length;
    expect(screen.getAllByText("Yes")).toHaveLength(allowed);
    expect(screen.getAllByText("No")).toHaveLength(CLASS_CAPABILITIES.length - allowed);
  });
});
