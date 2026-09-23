// @vitest-environment jsdom

/**
 * The way back from a screen inside a tab.
 *
 * Small, and the reason it exists is not: **an installed iOS PWA has no
 * browser back button.** In standalone display mode Safari's chrome is gone
 * entirely, so a screen with no in-app way back is a dead end reachable only
 * by force-quitting the app.
 *
 * Two properties follow from that and neither is obvious from reading the
 * markup, which is why they are pinned here.
 */

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { BackLink } from "./BackLink.js";

afterEach(cleanup);

function show(to = "/fr", label = "French") {
  render(
    <MemoryRouter>
      <BackLink to={to} label={label} />
    </MemoryRouter>,
  );
  return screen.getByRole("link");
}

describe("the way back", () => {
  /**
   * Names its destination. "Back" alone tells a screen-reader user they can
   * leave and not where to — and on a screen reached by a shared link, they
   * may have no idea where they are in the first place.
   */
  it("says what it goes back to, not just that it goes back", () => {
    const link = show("/fr", "French");

    expect(link).toHaveAccessibleName(/back to french/i);
  });

  it("goes where it was told", () => {
    expect(show("/fr/journey", "Journey")).toHaveAttribute("href", "/fr/journey");
  });

  /**
   * The chevron is decoration beside a text label that already says it, so
   * announcing it would read the control twice.
   */
  it("hides its chevron from a screen reader", () => {
    const link = show();
    const chevron = link.querySelector(".back-chevron");

    expect(chevron).not.toBeNull();
    expect(chevron).toHaveAttribute("aria-hidden", "true");
  });

  /**
   * A real link, not a button that calls `history.back()`.
   *
   * That distinction is the whole design: a screen reached by a typed URL or a
   * shared link has no history to go back through, and a control that
   * depended on history would do nothing in exactly the case where somebody is
   * most lost. It is also why it is unconditional rather than shown only when
   * history is deep.
   */
  it("is a link to a destination rather than a step through history", () => {
    const link = show();

    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href");
  });
});
