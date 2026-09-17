// @vitest-environment jsdom

/**
 * The class list.
 *
 * The board calls alphabetical "the only order there is", and that is the
 * property worth testing: not that sorting is disabled, but that there is
 * nothing on a row a class could be ranked by.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PupilList } from "./PupilList.js";
import type { PupilRow } from "../teacher/roster.js";

afterEach(cleanup);

const WEEK = ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"];

function row(over: Partial<PupilRow> = {}): PupilRow {
  return {
    label: "Amara",
    anonymous: false,
    days: ["2026-09-15", "2026-09-14"],
    lastPractised: "2026-09-15",
    workingOn: ["ʁ"],
    capture: null,
    ...over,
  };
}

function show(rows: PupilRow[], onOpen?: (label: string) => void) {
  render(<PupilList rows={rows} week={WEEK} {...(onOpen ? { onOpen } : {})} />);
}

describe("what a row carries", () => {
  it("shows a name and how many days, and no figure", () => {
    show([row({ label: "Amara", days: ["a", "b", "c", "d"] })]);

    expect(screen.getByText("Amara")).toBeInTheDocument();
    expect(screen.getByText("4 days")).toBeInTheDocument();
  });

  it("says one day rather than 1 days", () => {
    show([row({ days: ["2026-09-15"] })]);
    expect(screen.getByText("1 day")).toBeInTheDocument();
  });

  /**
   * A strip of squares is a figure encoded in colour. Each day is written out
   * for a screen reader, because colour is never the only carrier in this
   * product.
   */
  it("writes each day out, so the strip is not the only carrier", () => {
    show([row({ days: ["2026-09-15"] })]);

    expect(screen.getByText(/2026-09-15 practised/)).toBeInTheDocument();
    expect(screen.getByText(/2026-09-14 did not practise/)).toBeInTheDocument();
  });

  it("marks exactly the days practised, and no others", () => {
    show([row({ days: ["2026-09-15", "2026-09-17"] })]);

    const strip = screen.getByLabelText("Practice days for Amara");
    const on = within(strip).getAllByRole("listitem").filter((li) => li.className.includes("is-on"));
    expect(on).toHaveLength(2);
  });
});

describe("the order", () => {
  /**
   * Stated on the screen because it is the honest description: there is no
   * sort control and no column that could carry one.
   */
  it("says alphabetical is the only order, and offers no control", () => {
    show([row({ label: "Amara" }), row({ label: "Ben" })]);

    expect(screen.getByText(/the only order there is/i)).toBeInTheDocument();
    expect(screen.queryByRole("columnheader")).toBeNull();
  });

  /**
   * The order arrives already decided, and the list must not have an opinion.
   * The rows below carry *different* day counts, deliberately: an earlier
   * version gave them all the same number, so re-sorting by days was a stable
   * no-op and the mutation that added one survived.
   *
   * This is the safeguard rather than a preference. Alphabetical is the only
   * order the teacher view has, and a component quietly imposing another would
   * hand back the ranking the whole design exists without.
   */
  it("renders the rows in the order it was handed, without re-sorting", () => {
    show([
      row({ label: "Amara", days: ["2026-09-15"] }),
      row({ label: "Ben", days: [] }),
      row({ label: "Chloe", days: ["2026-09-14", "2026-09-15", "2026-09-16"] }),
    ]);

    const rendered = screen
      .getAllByRole("listitem")
      .map((li) => li.textContent ?? "")
      .filter((text) => /Amara|Ben|Chloe/.test(text));

    expect(rendered[0]).toContain("Amara");
    expect(rendered[1]).toContain("Ben");
    expect(rendered[2]).toContain("Chloe");
  });
});

describe("a pupil who joined without a name", () => {
  /**
   * The board: it "needs no explanation". So the row is ordinary — not greyed,
   * not marked incomplete — and the note appears once for the list rather than
   * as an apology on the row.
   */
  it("explains the label once, for the list", () => {
    show([row({ label: "Amara" }), row({ label: "Pupil 1", anonymous: true })]);

    expect(screen.getAllByText(/joined without a name/i)).toHaveLength(1);
  });

  it("says nothing when everyone shared a name", () => {
    show([row({ label: "Amara" }), row({ label: "Ben" })]);

    expect(screen.queryByText(/joined without a name/i)).toBeNull();
  });
});

describe("opening a pupil", () => {
  it("offers a real control, not a clickable row", () => {
    const onOpen = vi.fn();
    show([row({ label: "Amara" })], onOpen);

    fireEvent.click(screen.getByRole("button", { name: "Amara" }));
    expect(onOpen).toHaveBeenCalledWith("Amara");
  });

  it("renders plain names when there is nowhere to open", () => {
    show([row({ label: "Amara" })]);

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Amara")).toBeInTheDocument();
  });
});
