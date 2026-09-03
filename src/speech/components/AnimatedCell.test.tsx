// @vitest-environment jsdom

/**
 * The point of `from` is that the motion carries a comparison. Counting up
 * from zero states a score; counting up from the learner's previous best
 * states the improvement, which is what they want to know on attempt two.
 *
 * These assert the resolved state rather than the animation. jsdom reports no
 * reduced-motion preference by default, so the hook takes its rAF path and
 * settles on the target — which is exactly what a learner sees a beat later,
 * and the only part worth pinning.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { AnimatedCell } from "./AnimatedCell.js";

beforeAll(() => {
  // useCountUp reads prefers-reduced-motion directly, which jsdom does not
  // implement. Report "no preference" so the normal path runs.
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
});

afterEach(cleanup);

describe("AnimatedCell improvement delta", () => {
  it("shows the gain when the learner beat their previous best", () => {
    render(<AnimatedCell value={68} label="accuracy" from={52} />);

    expect(screen.getByText("+16")).toBeInTheDocument();
  });

  it("shows no delta on a first attempt, where there is nothing to beat", () => {
    const { container } = render(<AnimatedCell value={68} label="accuracy" />);

    expect(container.querySelector(".gain")).toBeNull();
  });

  it("stays silent on a worse retry rather than rubbing it in", () => {
    // A negative delta is true, and unhelpful mid-session: the score already
    // says it, and `best` is what the pass gate uses regardless.
    const { container } = render(<AnimatedCell value={44} label="accuracy" from={61} />);

    expect(container.querySelector(".gain")).toBeNull();
  });

  it("stays silent when the retry merely matched the previous best", () => {
    const { container } = render(<AnimatedCell value={61} label="accuracy" from={61} />);

    expect(container.querySelector(".gain")).toBeNull();
  });

  it("renders an em dash, and no delta, for a value the scorer could not give", () => {
    // R8: an indeterminate attempt has no number, so there is nothing to
    // compare and nothing to celebrate.
    const { container } = render(<AnimatedCell value={null} label="accuracy" from={52} />);

    expect(screen.getByText("—")).toBeInTheDocument();
    expect(container.querySelector(".gain")).toBeNull();
  });

  it("rounds both sides before subtracting, so the delta matches what is shown", () => {
    // 67.6 displays as 68 and 52.4 as 52; a delta computed on the raw values
    // would read +15 beside a visible 68 and 52.
    render(<AnimatedCell value={67.6} label="accuracy" from={52.4} />);

    expect(screen.getByText("+16")).toBeInTheDocument();
  });
});
