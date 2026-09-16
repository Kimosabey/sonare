// @vitest-environment jsdom

/**
 * "Leave this sitting?" — and the properties that keep it from being a trap.
 *
 * The dialog exists because leaving used to be something that *happened to* a
 * learner: Android's Back, or a stray Esc, and the sitting was gone. What it is
 * not is a warning about a destructive act — there is no destructive act, and
 * that distinction drives everything below.
 *
 * Three things matter more than the copy:
 *
 *  - **No option throws work away.** Two buttons, both safe. A third would need
 *    a confirmation of its own, and nothing here needs one.
 *  - **Focus lands on the safe one.** A dialog opening with focus on the option
 *    that ends the session turns a stray Return — or a second Back press, which
 *    on Android is a reflex — into leaving.
 *  - **Esc means keep going.** The gesture that opens a question must not also
 *    answer it.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LeaveSittingDialog } from "./LeaveSittingDialog.js";

const keepGoing = vi.fn();
const leave = vi.fn();

function show(over: Partial<Parameters<typeof LeaveSittingDialog>[0]> = {}) {
  render(
    <LeaveSittingDialog
      position={2}
      total={4}
      hasScoredTake
      onKeepGoing={keepGoing}
      onLeave={leave}
      {...over}
    />,
  );
}

afterEach(() => {
  keepGoing.mockClear();
  leave.mockClear();
  cleanup();
});

describe("what it offers", () => {
  it("offers exactly two answers, and neither discards anything", () => {
    show();

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /discard|delete|lose|throw away/i })).toBeNull();
  });

  it("says progress is kept either way, which is the point", () => {
    show();
    expect(screen.getByText(/progress is kept either way/i)).toBeInTheDocument();
  });

  it("orients the learner in the sitting they are leaving", () => {
    show({ position: 2, total: 4 });
    expect(screen.getByText(/2 activities into 4/i)).toBeInTheDocument();
  });

  it("does not say 'activities' for one", () => {
    show({ position: 1, total: 4 });
    expect(screen.getByText(/1 activity into 4/i)).toBeInTheDocument();
  });

  /**
   * A learner who believes leaving loses the take they just recorded will sit
   * through an activity they do not have time for. The claim is true —
   * `applyTake` writes through on every take — so it is worth making.
   */
  it("says a scored take is already counted", () => {
    show({ hasScoredTake: true });
    expect(screen.getByText(/already been scored and counted/i)).toBeInTheDocument();
  });

  it("says nothing about a take when there has not been one", () => {
    show({ hasScoredTake: false });
    expect(screen.queryByText(/already been scored/i)).not.toBeInTheDocument();
  });
});

describe("how it behaves under a reflex", () => {
  it("focuses the safe option", () => {
    show();
    expect(screen.getByRole("button", { name: /Keep going/i })).toHaveFocus();
  });

  /** Tabbing forward must reach the safe one first, not merely focus it. */
  it("puts the safe option first in the document", () => {
    show();

    const buttons = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    expect(buttons[0]).toMatch(/Keep going/i);
  });

  it("treats Esc as keeping going, never as leaving", () => {
    show();
    fireEvent.keyDown(window, { key: "Escape" });

    expect(keepGoing).toHaveBeenCalled();
    expect(leave).not.toHaveBeenCalled();
  });

  it("leaves only when the learner says so", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: /Leave and come back later/i }));

    expect(leave).toHaveBeenCalled();
  });
});

describe("what a screen reader is told", () => {
  it("is a modal dialog, named and described by its own text", () => {
    show();

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Leave this sitting?");
    expect(dialog).toHaveAccessibleDescription(/progress is kept either way/i);
  });
});
