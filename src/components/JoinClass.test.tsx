// @vitest-environment jsdom

/**
 * The decision a pupil is asked to make.
 *
 * The board's rule is that the list here is the same one the teacher was
 * shown, "so neither side is told a different story" — so the tests read the
 * promise module rather than hard-coding sentences. A screen that listed its
 * own copy would pass its tests forever while drifting from the teacher's.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JoinClass } from "./JoinClass.js";
import { NEVER_SHARED_WITH_CLASS, SHARED_WITH_CLASS } from "../teacher/promise.js";

afterEach(cleanup);

function show(over: Partial<Parameters<typeof JoinClass>[0]> = {}) {
  const onJoin = vi.fn();
  const onDecline = vi.fn();
  render(
    <JoinClass
      className="Year 9 French"
      teacherName="Mr Okonjo"
      learnerName="Maya"
      onJoin={onJoin}
      onDecline={onDecline}
      {...over}
    />,
  );
  return { onJoin, onDecline };
}

describe("the consequences are listed before the choice", () => {
  it("shows every fact the class will see", () => {
    show();

    for (const fact of SHARED_WITH_CLASS) {
      expect(screen.getByText(fact.because)).toBeInTheDocument();
    }
  });

  /**
   * The half a pupil is actually deciding about. A join screen that lists what
   * is shared and summarises what is not is a consent screen that has not
   * obtained consent to anything in particular.
   */
  it("shows every fact the class will never see, with the reason", () => {
    show();

    for (const fact of NEVER_SHARED_WITH_CLASS) {
      expect(screen.getByText(fact.label)).toBeInTheDocument();
      expect(screen.getByText(fact.because)).toBeInTheDocument();
    }
  });

  it("names the teacher who will see it, rather than saying 'your teacher'", () => {
    show();

    expect(screen.getByText(/Mr Okonjo will be able to see/)).toBeInTheDocument();
  });

  /**
   * The fact that makes the decision safe to make, and the reason it is on the
   * screen rather than in a help page.
   */
  it("says the decision can be undone, both ways", () => {
    show();

    expect(
      screen.getByText(/leave the class at any time, and remove your name without leaving/i),
    ).toBeInTheDocument();
  });
});

describe("the name that would travel", () => {
  /**
   * A pupil agreeing to share "your first name, if you gave one" has to go and
   * look up what that is. Showing the actual name is the difference between
   * consenting to a policy and consenting to a fact.
   */
  it("shows the name that would actually be shared", () => {
    show({ learnerName: "Maya" });

    expect(screen.getByText("Your first name, Maya")).toBeInTheDocument();
  });

  it("falls back to the general promise when no name was given", () => {
    show({ learnerName: null });

    const nameFact = SHARED_WITH_CLASS.find((f) => f.label.startsWith("Your first name"));
    expect(nameFact).toBeDefined();
    expect(screen.getByText(nameFact?.label ?? "")).toBeInTheDocument();
  });
});

describe("the three choices", () => {
  /**
   * "Join without my name" is a peer of "Join the class", not a link beneath
   * it. A name list is itself a privacy surface, and a pupil who wants the
   * lesson without being on one should not have to hunt for that.
   */
  it("offers joining without a name as a button, not as fine print", () => {
    show();

    const withoutName = screen.getByRole("button", { name: "Join without my name" });
    expect(withoutName.tagName).toBe("BUTTON");
    expect(withoutName).not.toHaveClass("ghost");
  });

  it("reports which of the two joins was chosen", () => {
    const { onJoin } = show();

    fireEvent.click(screen.getByRole("button", { name: "Join the class" }));
    expect(onJoin).toHaveBeenCalledWith({ shareName: true });

    fireEvent.click(screen.getByRole("button", { name: "Join without my name" }));
    expect(onJoin).toHaveBeenLastCalledWith({ shareName: false });
  });

  /**
   * With no name given, the two buttons would do exactly the same thing. A
   * choice between identical outcomes is theatre, and it implies the pupil has
   * a name on file that they do not.
   */
  it("offers only one join when there is no name to withhold", () => {
    show({ learnerName: null });

    expect(screen.queryByRole("button", { name: "Join without my name" })).toBeNull();
    expect(screen.getByRole("button", { name: "Join the class" })).toBeInTheDocument();
  });

  it("declines without joining", () => {
    const { onJoin, onDecline } = show();

    fireEvent.click(screen.getByRole("button", { name: "Not now" }));

    expect(onDecline).toHaveBeenCalled();
    expect(onJoin).not.toHaveBeenCalled();
  });

  it("stops every choice while a join is in flight", () => {
    show({ busy: true });

    for (const name of ["Joining…", "Join without my name", "Not now"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
  });
});
