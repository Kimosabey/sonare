// @vitest-environment jsdom

/**
 * FR-06's level meter, and the one thing on the recording screen that has to
 * be right thirty times a second for the whole take.
 *
 * Two claims worth pinning. The bar is driven by `transform: scaleX()` rather
 * than `width`, and that is not a style preference: this element changes 30
 * times a second, and animating width puts layout and paint on every one of
 * those frames — on exactly the frames the recording UI needs to stay smooth.
 * A refactor back to a percentage width would look identical in a screenshot
 * and cost layout for the whole take.
 *
 * And `clipping` is a separate input from `level` on purpose. RMS sits around
 * -8 dBFS on audio peaking at +8, so the bar reads perfectly healthy while the
 * take is being destroyed. Deriving the warning from `level` is the intuitive
 * thing to do and it cannot work.
 */

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { LevelMeter } from "./LevelMeter.js";

afterEach(cleanup);

/** The scaled bar itself. */
function bar(): HTMLElement {
  const node = document.querySelector(".meter > i");
  if (!node) throw new Error("no bar rendered");
  return node as HTMLElement;
}

function scaleOf(): number {
  const match = /scaleX\(([\d.]+)\)/.exec(bar().style.transform);
  return match ? Number(match[1]) : NaN;
}

describe("the bar is composited, not laid out", () => {
  it("drives the bar with a transform and never a width", () => {
    /**
     * The performance claim, asserted where it can regress. `width` would
     * produce the same picture and put layout on 30 frames a second for the
     * length of every take.
     */
    render(<LevelMeter level={-20} active />);

    expect(bar().style.transform).toMatch(/scaleX\(/);
    expect(bar().style.width).toBe("");
  });
});

describe("mapping dBFS onto the bar", () => {
  it("shows nothing at the bottom of the range and everything at the top", () => {
    // -70 dBFS is the documented floor of the useful speech range; 0 is full
    // scale.
    render(<LevelMeter level={-70} active />);
    expect(scaleOf()).toBeCloseTo(0, 3);

    cleanup();
    render(<LevelMeter level={0} active />);
    expect(scaleOf()).toBeCloseTo(1, 3);
  });

  it("puts a normal speaking level in the upper half, where it is readable", () => {
    // Real takes measured on this project peaked -12 to -20 dBFS. If those
    // rendered as a sliver, a learner speaking correctly would keep talking
    // louder to make the bar move.
    render(<LevelMeter level={-20} active />);

    expect(scaleOf()).toBeGreaterThan(0.6);
    expect(scaleOf()).toBeLessThan(0.85);
  });

  it("clamps rather than overflowing on an over-driven input", () => {
    /**
     * Web Audio Float32 is not bounded to +/-1, so a positive dBFS genuinely
     * arrives here. An unclamped scale of 1.1 would push the bar outside its
     * own track.
     */
    render(<LevelMeter level={12} active />);

    expect(scaleOf()).toBe(1);
  });

  it("clamps at the bottom on the silence floor", () => {
    // Silence sits near -90, below the -70 the range starts at.
    render(<LevelMeter level={-90} active />);

    expect(scaleOf()).toBe(0);
  });

  it("is monotonic, so louder always reads as more", () => {
    // A non-monotonic mapping would make the meter actively misleading — the
    // one thing a learner is using it to judge.
    let previous = -1;
    for (const level of [-90, -70, -60, -45, -30, -20, -10, -3, 0]) {
      cleanup();
      render(<LevelMeter level={level} active />);
      expect(scaleOf(), String(level)).toBeGreaterThanOrEqual(previous);
      previous = scaleOf();
    }
  });

  it("empties the bar when not recording, whatever the last level was", () => {
    // A meter frozen at its last value after a take reads as still listening.
    render(<LevelMeter level={-10} active={false} />);

    expect(scaleOf()).toBe(0);
  });
});

describe("the clipping warning", () => {
  it("warns from the clipping flag, not from the level", () => {
    /**
     * The whole reason `clipping` is a separate prop. A take peaking at +8
     * dBFS has an RMS around -8, which is a healthy-looking bar — so a meter
     * that inferred distortion from `level` would stay silent on exactly the
     * takes that need the warning.
     */
    render(<LevelMeter level={-8} active clipping />);

    expect(screen.getByText("distorting — back off the mic")).toBeInTheDocument();
  });

  it("does not warn on a loud but clean level", () => {
    // Loud is not distorting. Warning here would push learners to speak too
    // quietly, which is the failure mode that actually loses takes.
    render(<LevelMeter level={-3} active />);

    expect(screen.queryByText("distorting — back off the mic")).not.toBeInTheDocument();
    expect(screen.getByText("hearing you")).toBeInTheDocument();
  });

  it("stays silent about clipping when not recording", () => {
    // A stale warning from the previous take, sitting on screen before the
    // next one starts, is advice about nothing.
    render(<LevelMeter level={0} active={false} clipping />);

    expect(screen.queryByText("distorting — back off the mic")).not.toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("marks the meter itself, so the warning is visible without reading", () => {
    render(<LevelMeter level={-8} active clipping />);

    expect(document.querySelector(".meter")).toHaveClass("meter-hot");
  });

  it("interrupts a screen reader only for the warning", () => {
    /**
     * A learner mid-recording is looking at the prompt. "Hearing you" changing
     * politely is right; distortion is worth interrupting for, because it is
     * the difference between finishing the take and having it rejected. An
     * assertive region on the routine status would talk over them for the
     * whole take.
     */
    render(<LevelMeter level={-8} active clipping />);
    expect(screen.getByText("distorting — back off the mic")).toHaveAttribute("aria-live", "assertive");

    cleanup();
    render(<LevelMeter level={-20} active />);
    expect(screen.getByText("hearing you")).toHaveAttribute("aria-live", "off");
  });
});

describe("what the learner is not shown", () => {
  it("prints no dBFS numeral anywhere", () => {
    /**
     * "-42.3 dBFS" is engineering units in a learner's interface: it reassures
     * nobody who does not already know what dBFS is, and the bar beside it
     * carries the same information in a form that needs no training. The
     * figure still reaches the attempt trail and ?debug=1, which are the two
     * places it is actually read.
     */
    render(<LevelMeter level={-42.3} active />);

    expect(document.querySelector(".meter")?.textContent ?? "").not.toMatch(/-?\d/);
    expect(screen.queryByText(/dBFS/i)).not.toBeInTheDocument();
  });

  it("says something in every state, so the row is never blank", () => {
    for (const props of [
      { level: -20, active: true },
      { level: -20, active: false },
      { level: -8, active: true, clipping: true },
    ]) {
      cleanup();
      render(<LevelMeter {...props} />);
      expect((document.querySelector(".meter")?.textContent ?? "").trim().length).toBeGreaterThan(0);
    }
  });
});
