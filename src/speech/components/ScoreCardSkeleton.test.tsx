// @vitest-environment jsdom

/**
 * The skeleton's job is to hold the score card's shape for the ~1.4s the
 * provider takes (p50 1370ms measured), so what matters is that it says
 * something real without motion and never implies a number it does not have.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ScoreCardSkeleton } from "./ScoreCardSkeleton.js";

afterEach(cleanup);

describe("ScoreCardSkeleton", () => {
  it("says what is happening in real text, not only by shimmering", () => {
    // The global prefers-reduced-motion rule strips every animation, so a
    // skeleton that communicates only through movement communicates nothing
    // to a learner with that preference set.
    render(<ScoreCardSkeleton />);

    expect(screen.getByText(/scoring your take/i)).toBeInTheDocument();
  });

  it("shows the four labels for real, since they are never unknown", () => {
    const { container } = render(<ScoreCardSkeleton />);

    const labels = [...container.querySelectorAll(".overall .l")].map((e) => e.textContent);
    expect(labels).toEqual(["overall", "accuracy", "fluency", "complete"]);
  });

  it("renders no digits at all — a skeleton must not imply a score", () => {
    const { container } = render(<ScoreCardSkeleton />);

    // The whole point of R8's honesty boundary applies to the waiting state
    // too: any number here would be invented.
    expect(container.textContent).not.toMatch(/\d/);
  });

  it("keeps the real card's geometry so the result replaces it in place", () => {
    const { container } = render(<ScoreCardSkeleton />);

    // Same `.overall` four-cell grid as ScoreCard, so nothing shifts on swap.
    expect(container.querySelectorAll(".overall > div")).toHaveLength(4);
    expect(container.querySelector(".overall")).toHaveClass("overall-pending");
    expect(container.querySelectorAll(".sk-chip")).toHaveLength(3);
  });

  it("hides the decorative bars from assistive tech, keeping only the status", () => {
    const { container } = render(<ScoreCardSkeleton />);

    // Placeholder bars announce nothing useful; the status line is the message.
    expect(container.querySelector(".overall")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(".sk-words")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText(/scoring your take/i)).not.toHaveAttribute("aria-hidden");
  });
});
