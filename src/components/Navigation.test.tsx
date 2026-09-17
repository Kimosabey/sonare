// @vitest-environment jsdom

/**
 * The four destinations, and the three rules about them that are not cosmetic.
 *
 * **Four, never five.** The set is a map of what the learner is doing, not a
 * list of what the app contains. A fifth entry is how the second becomes true.
 *
 * **It is gone during a sitting, not dimmed.** A sitting is the one flow with a
 * finish line, and a tab bar beside it is a standing invitation to leave it
 * half-done. Disabled tabs would be worse than either: a control that looks
 * like a way out and is not.
 *
 * **Current is never colour alone.** The same rule the score bands keep, and on
 * a row of four identical shapes colour is the least noticeable of the three
 * carriers anyway.
 */

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { Navigation } from "./Navigation.js";

function show(props: { slug: string | null; hidden?: boolean }, at = "/") {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <Navigation {...props} />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe("the destinations", () => {
  it("offers exactly four", () => {
    show({ slug: "fr" });

    expect(screen.getAllByRole("link")).toHaveLength(4);
  });

  it("names them Today, Journey, Progress and You", () => {
    show({ slug: "fr" });

    for (const label of ["Today", "Journey", "Progress", "You"]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
  });

  /**
   * Icon-only tabs are a guessing game for anyone who does not already know
   * the app, and these are four short words. The glyphs are decorative, so a
   * screen reader announces each destination once rather than twice.
   */
  it("labels every tab, and announces the mark as nothing", () => {
    show({ slug: "fr" });

    expect(screen.getByRole("link", { name: "Today" })).toBeInTheDocument();

    const marks = document.querySelectorAll(".tab-icon");
    // Asserted rather than assumed: the loop below vouches for nothing if the
    // selector matches no elements, which is exactly what happened when the
    // marks stopped being `.tab-glyph` spans and this test kept passing.
    expect(marks).toHaveLength(4);
    for (const mark of marks) {
      expect(mark).toHaveAttribute("aria-hidden", "true");
    }
  });

  /**
   * Drawn, not typed. `⚙` U+2699 defaults to *emoji* presentation on iOS and
   * Android with no U+FE0E selector, so one tab in four rendered as a
   * full-colour gear beside three monochrome outlines — and a colour emoji
   * ignores `color`, so the current state's colour never reached it.
   */
  it("draws every mark rather than typing a character", () => {
    show({ slug: "fr" });

    const marks = [...document.querySelectorAll(".tab-icon")];
    expect(marks).toHaveLength(4);
    for (const mark of marks) {
      expect(mark.tagName.toLowerCase()).toBe("svg");
      // Takes the tab's colour, which is what the emoji could not do.
      expect(mark.getAttribute("stroke")).toBe("currentColor");
    }
  });

  /**
   * No tab renders a character from the ranges that default to emoji. Written
   * as a rule over the whole bar rather than as a check on the gear, so
   * reaching for another decorative codepoint later fails here.
   */
  it("carries no character that a platform may render in colour", () => {
    show({ slug: "fr" });

    const text = document.querySelector(".tabs")?.textContent ?? "";
    for (const character of text) {
      const cp = character.codePointAt(0) ?? 0;
      const defaultsToEmoji =
        cp === 0x2699 || cp === 0x2600 || cp === 0x26a0 || (cp >= 0x1f300 && cp <= 0x1faff);
      expect(defaultsToEmoji, `U+${cp.toString(16)} may render as a colour emoji`).toBe(false);
    }
  });

  it("points the per-language destinations at the learner's language", () => {
    show({ slug: "fr" });

    expect(screen.getByRole("link", { name: "Journey" })).toHaveAttribute("href", "/fr/journey");
    expect(screen.getByRole("link", { name: "Progress" })).toHaveAttribute("href", "/fr/progress");
  });

  /**
   * The bar must not change shape on the second visit. A navigation that grows
   * as you use it is one nobody can learn, so the destinations that need a
   * language point at the screen that supplies one.
   */
  it("keeps all four before the learner has a language", () => {
    show({ slug: null });

    expect(screen.getAllByRole("link")).toHaveLength(4);
    expect(screen.getByRole("link", { name: "Journey" })).toHaveAttribute("href", "/languages");
  });
});

describe("during a sitting", () => {
  it("is gone entirely, not dimmed or disabled", () => {
    const { container } = show({ slug: "fr", hidden: true });

    expect(container).toBeEmptyDOMElement();
  });
});

describe("saying where the learner is", () => {
  it("marks the current destination with more than a colour", () => {
    show({ slug: "fr" }, "/fr/journey");

    const journey = screen.getByRole("link", { name: "Journey" });
    expect(journey).toHaveClass("is-current");
    // The class carries a weight and an inset rule as well as the hue — see
    // navigation.css. What matters here is that exactly one is marked.
    expect(document.querySelectorAll(".is-current")).toHaveLength(1);
  });

  /**
   * `end` on Today, because "/" is a prefix of every route in the app. Without
   * it the whole bar renders as current, everywhere.
   */
  it("does not mark Today as current from inside another destination", () => {
    show({ slug: "fr" }, "/fr/progress");

    expect(screen.getByRole("link", { name: "Today" })).not.toHaveClass("is-current");
    expect(screen.getByRole("link", { name: "Progress" })).toHaveClass("is-current");
  });

  it("marks Today as current on Today", () => {
    show({ slug: "fr" }, "/");

    expect(screen.getByRole("link", { name: "Today" })).toHaveClass("is-current");
  });
});
