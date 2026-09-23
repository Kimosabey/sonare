// @vitest-environment jsdom

/**
 * "Not here yet" — a roadmap on a screen, which is a promise pointed at the
 * future.
 *
 * This product refuses to show a score it did not measure, a count it cannot
 * check, or a figure about a child it has no right to. A coming-soon list is
 * the same kind of claim, so `planned.ts` gives it the same treatment: no
 * dates, only decisions already taken, and phrased as what a learner will be
 * able to do rather than what we will build.
 *
 * `planned.test.ts` holds the list to those rules. This holds the component
 * to the one rule a list cannot enforce about itself: **an empty list must
 * render nothing at all**, not a heading over a void. Removing an entry is how
 * a feature ships, so the last removal must not leave "Not here yet" standing
 * over an empty box.
 */

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PLANNED } from "../planned.js";

afterEach(() => {
  vi.resetModules();
  cleanup();
});

describe("what is planned", () => {
  it("lists every entry, with the reason it is not here yet", async () => {
    const { Planned } = await import("./Planned.js");
    render(<Planned />);

    expect(PLANNED.length, "nothing is planned, so this asserts nothing").toBeGreaterThan(0);
    for (const feature of PLANNED) {
      expect(screen.getByText(feature.title)).toBeInTheDocument();
      expect(screen.getByText(feature.because)).toBeInTheDocument();
    }
  });

  /**
   * The rule the list cannot enforce about itself. Removing an entry is how a
   * feature ships, so the final removal has to take the heading with it —
   * otherwise "Not here yet" sits over nothing, which reads as a bug at best
   * and as a broken promise at worst.
   */
  it("renders nothing at all when nothing is planned", async () => {
    vi.resetModules();
    vi.doMock("../planned.js", () => ({ PLANNED: [] }));
    const { Planned } = await import("./Planned.js");

    const { container } = render(<Planned />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/not here yet/i)).toBeNull();
    vi.doUnmock("../planned.js");
  });

  /**
   * And no dates reach the screen, which is the one thing `planned.ts`'s
   * header is most insistent about: a date is the part of a promise that can
   * be broken while the work is still going well.
   */
  it("shows no date, quarter or soon", async () => {
    const { Planned } = await import("./Planned.js");
    render(<Planned />);

    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/\b20\d\d\b/);
    expect(text).not.toMatch(/\bQ[1-4]\b/);
    expect(text).not.toMatch(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/);
    expect(text).not.toMatch(/\bsoon\b/i);
  });
});
