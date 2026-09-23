// @vitest-environment jsdom

/**
 * The four marks in the tab bar.
 *
 * Small, and worth pinning for one reason: they are **decorative by design**,
 * and decorative is a claim that has to stay true. Every tab renders a visible
 * text label beside its mark, so an icon that announced itself would read each
 * destination twice to a screen reader — "Today, Today". The `aria-hidden` is
 * therefore not tidiness, it is the thing that stops the navigation being
 * twice as long to listen to as it is to look at.
 *
 * The rest is drift. Four marks drawn to one geometry cannot be kept in step
 * by intention, and the characters they replaced had already drifted once.
 */

import { cleanup, render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { TabIcon, type TabIconProps } from "./TabIcon.js";

afterEach(cleanup);

const NAMES: TabIconProps["name"][] = ["Today", "Journey", "Progress", "You"];

function draw(name: TabIconProps["name"]): SVGSVGElement {
  const { container } = render(<TabIcon name={name} />);
  const svg = container.querySelector("svg");
  if (svg === null) throw new Error(`${name} rendered no svg`);
  return svg;
}

describe("every tab mark", () => {
  it.each(NAMES)("%s draws something", (name) => {
    const svg = draw(name);

    // Non-vacuity: an empty <svg> would satisfy every other assertion here.
    expect(svg.querySelectorAll("path, circle, rect, line, polyline").length).toBeGreaterThan(0);
  });

  /**
   * The load-bearing one. The label beside the mark already names the
   * destination, so an announced icon says it twice.
   */
  it.each(NAMES)("%s is hidden from a screen reader", (name) => {
    expect(draw(name)).toHaveAttribute("aria-hidden", "true");
  });

  it.each(NAMES)("%s carries no accessible name of its own", (name) => {
    const svg = draw(name);

    expect(svg.getAttribute("aria-label")).toBeNull();
    expect(svg.querySelector("title")).toBeNull();
  });
});

describe("one geometry, four marks", () => {
  /**
   * Drawn to a shared box so they cannot drift apart. The characters these
   * replaced had already drifted once — four glyphs from four fonts, at four
   * optical weights.
   */
  it("uses the same viewBox everywhere", () => {
    const boxes = new Set(NAMES.map((name) => draw(name).getAttribute("viewBox")));

    expect(boxes.size, [...boxes].join(" / ")).toBe(1);
    expect([...boxes][0]).toBe("0 0 24 24");
  });

  it("uses the same stroke weight everywhere", () => {
    const widths = new Set(NAMES.map((name) => draw(name).getAttribute("stroke-width")));

    expect(widths.size, [...widths].join(" / ")).toBe(1);
  });

  /**
   * `currentColor`, so a mark takes the colour of the tab it sits in — active,
   * inactive, focused — without four more rules to keep in step.
   */
  it("takes its colour from the tab rather than fixing one", () => {
    for (const name of NAMES) {
      const svg = draw(name);
      const stroke = svg.getAttribute("stroke") ?? "";
      expect(stroke, name).toBe("currentColor");
      expect(svg.outerHTML, `${name} hard-codes a colour`).not.toMatch(/#[0-9a-f]{3,6}/i);
    }
  });

  /** And the four are actually different marks, not one drawn four times. */
  it("draws a different mark for each destination", () => {
    const shapes = NAMES.map((name) => draw(name).innerHTML);

    expect(new Set(shapes).size).toBe(NAMES.length);
  });
});
