// @vitest-environment jsdom

/**
 * The table that exists so an author can see what a set targets without
 * opening it.
 *
 * The properties worth pinning are the three distinctions the cell has to
 * make. "Scores no sounds by design", "scores sounds and has none", and "here
 * are its sounds" are three different states of an activity, and collapsing
 * any two of them produces a set that looks finished and schedules badly.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityOverview, NO_SOUNDS_SCORED } from "./ActivityOverview.js";
import type { DraftActivity } from "../content/draft.js";

afterEach(cleanup);

function activity(over: Partial<DraftActivity> = {}): DraftActivity {
  return {
    id: "1",
    title: "Greeting",
    kind: "repeat",
    prompt: "Say hello",
    gloss: "hello",
    target: "Bonjour",
    focus: "the French r",
    soundTargets: "bon, jour",
    distractors: "",
    ...over,
  } as DraftActivity;
}

function show(activities: DraftActivity[], selected: number | null = null) {
  const onSelect = vi.fn();
  render(
    <ActivityOverview
      activities={activities}
      code="fr-FR"
      selected={selected}
      onSelect={onSelect}
    />,
  );
  return { onSelect };
}

/** The cells of the row whose id button reads `id`. */
function rowCells(id: string): HTMLElement[] {
  const button = screen.getByRole("button", { name: id });
  const row = button.closest("tr");
  if (row === null) throw new Error(`no row for ${id}`);
  return within(row).getAllByRole("cell");
}

describe("the sounds column", () => {
  it("lists the syllables an activity drills", () => {
    show([activity({ soundTargets: "bon, jour" })]);

    expect(screen.getByText("bon · jour")).toBeInTheDocument();
  });

  /**
   * A `listen` activity asks nothing of the microphone, so an empty cell is
   * not a gap. Left blank it reads as an authoring oversight and invites
   * somebody to add targets the activity cannot measure.
   */
  it("says a listen activity scores none, rather than leaving the cell empty", () => {
    show([activity({ kind: "listen", soundTargets: "" })]);

    expect(screen.getByText(NO_SOUNDS_SCORED)).toBeInTheDocument();
  });

  /**
   * The distinction that matters most. This activity *does* score sounds and
   * has been given none, so the scheduler can only ever offer it as a fallback
   * — never because it drills something due. That is a different fact from the
   * listen row and gets a different sentence.
   */
  it("distinguishes an activity that scores sounds and has none", () => {
    show([activity({ kind: "repeat", soundTargets: "" })]);

    expect(screen.getByText(/offered without a reason/)).toBeInTheDocument();
    expect(screen.queryByText(NO_SOUNDS_SCORED)).not.toBeInTheDocument();
  });

  it("does not claim a listen activity is missing targets even when it has some", () => {
    show([activity({ kind: "listen", soundTargets: "bon, jour" })]);

    expect(screen.getByText(NO_SOUNDS_SCORED)).toBeInTheDocument();
    expect(screen.queryByText(/offered without a reason/)).not.toBeInTheDocument();
  });

  it("ignores stray separators rather than counting an empty target", () => {
    show([activity({ soundTargets: " bon , , jour , " })]);

    expect(screen.getByText("bon · jour")).toBeInTheDocument();
  });
});

describe("the row", () => {
  it("shows the id, kind and target of each activity", () => {
    show([activity({ id: "4", kind: "respond", target: "Où se trouve la pharmacie" })]);

    const cells = rowCells("4");
    expect(cells[1]).toHaveTextContent("respond");
    expect(cells[2]).toHaveTextContent("Où se trouve la pharmacie");
  });

  /**
   * The target is the phrase in the language being learnt, so it carries
   * `lang` like every other language-bearing string in the product.
   */
  it("marks the target as the content language", () => {
    show([activity({ target: "Bonjour" })]);

    expect(screen.getByText("Bonjour")).toHaveAttribute("lang", "fr-FR");
  });

  it("does not mark the kind as the content language", () => {
    show([activity({ kind: "respond" })]);

    expect(screen.getByText("respond")).not.toHaveAttribute("lang");
  });

  it("shows an empty target as empty rather than as a blank cell", () => {
    show([activity({ target: "  " })]);

    expect(screen.getByText("(empty)")).toBeInTheDocument();
  });

  it("shows a question mark for an activity with no id yet", () => {
    show([activity({ id: "" })]);

    expect(screen.getByRole("button", { name: "?" })).toBeInTheDocument();
  });
});

describe("choosing one", () => {
  /**
   * The control is a button inside the cell rather than a handler on the row.
   * A `<tr>` is not focusable and is not announced as actionable, so an
   * operator on a keyboard or a screen reader would have no way to open the
   * editor at all — which is the "nothing pointer-only" constraint.
   */
  it("offers a real control, not a clickable row", () => {
    show([activity({ id: "1" }), activity({ id: "2" })]);

    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("reports which activity was chosen, by index", () => {
    const { onSelect } = show([activity({ id: "1" }), activity({ id: "2" })]);

    fireEvent.click(screen.getByRole("button", { name: "2" }));

    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it("marks the selected row for assistive technology, not only in colour", () => {
    show([activity({ id: "1" }), activity({ id: "2" })], 1);

    expect(screen.getByRole("button", { name: "2" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "1" })).not.toHaveAttribute("aria-current");
  });
});

describe("an empty set", () => {
  it("says there is nothing rather than rendering a headed table with no rows", () => {
    show([]);

    expect(screen.getByText("No activities yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
