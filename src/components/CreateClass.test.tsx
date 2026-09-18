// @vitest-environment jsdom

/**
 * Creating a class.
 *
 * The board's rule — "a join code rather than a roster upload … never a list a
 * teacher types in about children" — is mostly a statement about what this
 * screen does *not* have, so that is most of what these check.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreateClass } from "./CreateClass.js";
import { LANGUAGES } from "../activities/languages/index.js";

afterEach(cleanup);

function show(over: Partial<Parameters<typeof CreateClass>[0]> = {}) {
  const onCreate = over.onCreate ?? vi.fn();
  render(<CreateClass onCreate={onCreate} {...over} />);
  return { onCreate };
}

function fill(name = "Year 9 French", teacher = "Mr Okonjo") {
  fireEvent.change(screen.getByLabelText("Class name"), { target: { value: name } });
  fireEvent.change(screen.getByLabelText("How pupils see you"), { target: { value: teacher } });
}

describe("there is no field for a pupil", () => {
  /**
   * The whole identity model rests on this. A roster field would make a class
   * a list a teacher types in about children, which is the thing the board
   * rules out — and it would have to be filled in before anybody consented.
   */
  /**
   * Enumerated rather than word-scanned.
   *
   * The first version of this searched every label for "pupil" and flagged
   * *this screen's own* "How pupils see you" — a field that collects the
   * teacher's display name. A word scan cannot express the thing that matters
   * here, which is the direction information flows: a class name and a teacher
   * name are facts about the teacher, and a roster would be facts about
   * children.
   *
   * So the fields are listed. A new one fails this test and has to be argued
   * for, which is the right amount of friction for a form whose emptiness is
   * the design.
   */
  it("collects exactly four things, none of them about a pupil", () => {
    show();

    const labelled = [...document.querySelectorAll("label")]
      .map((label) => label.textContent?.trim() ?? "")
      .filter((text) => text !== "");

    expect(labelled.sort()).toEqual(
      [
        "Class name",
        "How pupils see you",
        "Language",
        "First name onlyWhat they typed, if they typed one.",
        "Not at allAttendance as a count, nobody named.",
      ].sort(),
    );
  });

  it("offers no way to upload or type a list of anybody", () => {
    show();

    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(document.querySelector("textarea")).toBeNull();
  });
});

describe("how pupils appear", () => {
  it("offers not naming them at all as a real choice", () => {
    show();

    expect(screen.getByRole("radio", { name: /Not at all/ })).toBeInTheDocument();
    expect(screen.getByText(/Attendance as a count, nobody named/)).toBeInTheDocument();
  });

  /**
   * The consequence beside each option, not in a help page. A teacher choosing
   * between two labels without them is choosing between two words.
   */
  it("says what each choice costs the class list", () => {
    show();

    expect(screen.getByText(/What they typed, if they typed one/)).toBeInTheDocument();
    expect(screen.getByText(/Attendance as a count, nobody named/)).toBeInTheDocument();
  });

  /**
   * A setting that looks permanent gets chosen defensively, and the board says
   * both directions are open.
   */
  it("says the setting can be changed and a pupil can always withdraw", () => {
    show();

    expect(screen.getByText(/Either setting can be changed later/)).toBeInTheDocument();
    expect(screen.getByText(/always remove their own name/)).toBeInTheDocument();
  });

  /**
   * The control has to *look* chosen, not merely report a choice. Setting
   * `checked` to a constant left the callback correct and the radio visibly
   * unselected — a control that appears not to work, which a teacher clicks
   * again rather than trusting.
   */
  it("shows which option is selected", () => {
    show();

    const firstName = screen.getByRole("radio", { name: /First name only/ });
    const notAtAll = screen.getByRole("radio", { name: /Not at all/ });

    expect(firstName).toBeChecked();
    expect(notAtAll).not.toBeChecked();

    fireEvent.click(notAtAll);

    expect(notAtAll).toBeChecked();
    expect(firstName).not.toBeChecked();
  });

  it("reports the chosen visibility", () => {
    const { onCreate } = show();
    fill();

    fireEvent.click(screen.getByRole("radio", { name: /Not at all/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create the class" }));

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ visibility: "anonymous" }));
  });

  it("defaults to first names, which is the board's own default", () => {
    const { onCreate } = show();
    fill();

    fireEvent.click(screen.getByRole("button", { name: "Create the class" }));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ visibility: "first-name" }));
  });
});

describe("the language", () => {
  /**
   * Only what the product has. The board lists five; offering one with no
   * content would let a teacher create a class whose pupils have nothing to
   * practise and find out from them.
   */
  it("offers exactly the languages that have content", () => {
    show();

    const options = [...screen.getByLabelText("Language").querySelectorAll("option")];
    expect(options.map((o) => o.getAttribute("value"))).toEqual(LANGUAGES.map((l) => l.slug));
  });
});

describe("before it can be created", () => {
  it("needs a class name and a teacher name", () => {
    show();
    const button = screen.getByRole("button", { name: "Create the class" });

    expect(button).toBeDisabled();

    fill("Year 9 French", "");
    expect(button).toBeDisabled();

    fill("", "Mr Okonjo");
    expect(button).toBeDisabled();

    fill();
    expect(button).toBeEnabled();
  });

  it("does not accept whitespace as a name", () => {
    show();
    fill("   ", "   ");

    expect(screen.getByRole("button", { name: "Create the class" })).toBeDisabled();
  });

  it("trims what it sends", () => {
    const { onCreate } = show();
    fill("  Year 9 French  ", "  Mr Okonjo  ");

    fireEvent.click(screen.getByRole("button", { name: "Create the class" }));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Year 9 French", teacherName: "Mr Okonjo" }),
    );
  });
});

describe("once the class exists", () => {
  it("shows the code and says how long it lasts", () => {
    show({ code: "R4M8T-QWXYZ" });

    expect(screen.getByText("R4M8T-QWXYZ")).toBeInTheDocument();
    expect(screen.getByText(/Valid for this term · regenerate any time/i)).toBeInTheDocument();
  });

  /**
   * The sentence that makes the code safe to write on a whiteboard: it grants
   * the right to *offer* to join, and nothing about a pupil travels until they
   * agree.
   */
  it("says nothing about a pupil reaches the teacher before they decide", () => {
    show({ code: "R4M8T-QWXYZ" });

    expect(screen.getByText(/Nothing about them reaches you before that/)).toBeInTheDocument();
  });

  /**
   * Board 1b prints "regenerate any time" beside the code, and a promise in
   * copy with no control behind it is the gap this closes. A code on a
   * whiteboard outlives the term it was written for.
   */
  it("offers regenerating the code, and says what that costs", () => {
    const onRegenerate = vi.fn();
    show({ code: "R4M8T-QWXYZ", onRegenerate });

    fireEvent.click(screen.getByRole("button", { name: "Regenerate the code" }));
    expect(onRegenerate).toHaveBeenCalled();
    expect(screen.getByText(/stops the old code working/i)).toBeInTheDocument();
  });

  /**
   * The reassurance matters as much as the warning: a teacher who thinks
   * regenerating might eject their class will never do it, and will keep a
   * stale code on the board instead.
   */
  it("says nobody already in the class is affected", () => {
    show({ code: "R4M8T-QWXYZ", onRegenerate: vi.fn() });

    expect(screen.getByText(/Nobody already in the class is affected/i)).toBeInTheDocument();
  });

  it("stops asking for the details once they are used", () => {
    show({ code: "R4M8T-QWXYZ" });

    expect(screen.queryByLabelText("Class name")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create the class" })).toBeNull();
  });
});
