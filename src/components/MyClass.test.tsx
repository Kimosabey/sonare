// @vitest-environment jsdom

/**
 * The pupil's copy of the promise, and the two ways out of it.
 *
 * The board's word is that a pupil can "check the promise rather than take
 * it", so the tests are about completeness and reversibility: the same lists
 * the teacher's view is built from, and both exits actually offered.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MyClass } from "./MyClass.js";
import { NEVER_SHARED_WITH_CLASS, SHARED_WITH_CLASS } from "../teacher/promise.js";

afterEach(cleanup);

function show(over: Partial<Parameters<typeof MyClass>[0]> = {}) {
  const onRemoveName = vi.fn();
  const onLeave = vi.fn();
  render(
    <MyClass
      className="Year 9 French"
      teacherName="Mr Okonjo"
      joinedAt="2026-03-04"
      sharedName="Maya"
      onRemoveName={onRemoveName}
      onLeave={onLeave}
      {...over}
    />,
  );
  return { onRemoveName, onLeave };
}

describe("the promise, in full", () => {
  /**
   * Read from the same module the teacher's limits page reads. A hand-written
   * copy here would be the drift the board rules out — and this is the side a
   * pupil would have no way to check.
   */
  it("lists every shared and withheld fact from the one source", () => {
    show();

    for (const fact of [...SHARED_WITH_CLASS, ...NEVER_SHARED_WITH_CLASS]) {
      expect(screen.getByText(fact.label)).toBeInTheDocument();
    }
  });

  it("names the teacher who can see it", () => {
    show();
    expect(screen.getByText("Mr Okonjo can see")).toBeInTheDocument();
  });

  it("says it reads the same list the class view is built from", () => {
    show();
    expect(screen.getByText(/the same list the class view is built from/i)).toBeInTheDocument();
  });

  it("says when they joined and under what name", () => {
    show();
    expect(screen.getByText(/Joined 2026-03-04 · as Maya/)).toBeInTheDocument();
  });

  it("says so plainly when they joined without a name", () => {
    show({ sharedName: null });
    expect(screen.getByText(/without a name/)).toBeInTheDocument();
  });
});

describe("two exits, not one", () => {
  /**
   * A pupil who wants out of a name list but still wants the suggestions
   * should not have to leave — and leaving should not be the price of changing
   * their mind about being named.
   */
  it("offers removing a name and leaving as separate actions", () => {
    show();

    expect(screen.getByRole("button", { name: "Remove my name" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Leave the class" })).toBeInTheDocument();
  });

  it("reports each separately", () => {
    const { onRemoveName, onLeave } = show();

    fireEvent.click(screen.getByRole("button", { name: "Remove my name" }));
    expect(onRemoveName).toHaveBeenCalled();
    expect(onLeave).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Leave the class" }));
    expect(onLeave).toHaveBeenCalled();
  });

  /**
   * With no name shared, the button would do nothing and imply a name is on
   * file that is not.
   */
  it("offers no name removal when there is no name to remove", () => {
    show({ sharedName: null });

    expect(screen.queryByRole("button", { name: "Remove my name" })).toBeNull();
    expect(screen.getByRole("button", { name: "Leave the class" })).toBeInTheDocument();
  });

  /**
   * Without this line, leaving reads like deleting — and a pupil weighing
   * whether to stay in a class should not have to wonder whether it costs them
   * their practice.
   */
  it("says leaving keeps everything they have learned", () => {
    show();

    expect(screen.getByText(/Leaving keeps everything you have learned/)).toBeInTheDocument();
    expect(screen.getByText(/only stops the sharing/)).toBeInTheDocument();
  });

  it("stops both while a change is in flight", () => {
    show({ busy: true });

    expect(screen.getByRole("button", { name: "Remove my name" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Leave the class" })).toBeDisabled();
  });
});
