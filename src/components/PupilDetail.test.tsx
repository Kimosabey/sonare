// @vitest-environment jsdom

/**
 * One pupil, opened.
 *
 * The board says what this screen is for: "Opening a pupil gives a teacher one
 * thing to do: have a word." So the tests are about what a teacher could act
 * on, and about the one sentence that stops them hunting for a score.
 */

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { PupilDetail } from "./PupilDetail.js";
import type { PupilRow } from "../teacher/roster.js";

afterEach(cleanup);

const TODAY = new Date("2026-09-17T09:00:00.000Z");

function row(over: Partial<PupilRow> = {}): PupilRow {
  return {
    label: "Ben",
    anonymous: false,
    days: ["2026-09-05"],
    lastPractised: "2026-09-05",
    workingOn: ["ʁ", "an"],
    capture: null,
    ...over,
  };
}

function show(over: Partial<Parameters<typeof PupilDetail>[0]> = {}) {
  render(<PupilDetail row={row()} code="fr-FR" today={TODAY} {...over} />);
}

describe("what a teacher can act on", () => {
  it("says how long it has been", () => {
    show();
    expect(screen.getByText("Has not practised in 12 days.")).toBeInTheDocument();
  });

  it("says today rather than in 0 days", () => {
    show({ row: row({ days: ["2026-09-17"], lastPractised: "2026-09-17" }) });
    expect(screen.getByText("Practised today.")).toBeInTheDocument();
  });

  it("says a pupil has not started, rather than counting from nowhere", () => {
    show({ row: row({ days: [], lastPractised: null }) });
    expect(screen.getByText("Has not practised yet.")).toBeInTheDocument();
  });

  it("names the sounds, marked as the content language", () => {
    show();
    expect(screen.getByText("ʁ · an")).toHaveAttribute("lang", "fr-FR");
  });

  /**
   * The useful comparison is against the class, because that is what decides
   * whether this is a conversation or a lesson.
   */
  it("says whether these are the sounds the class is on", () => {
    show({ classSounds: ["ʁ", "an"] });
    expect(screen.getByText(/the same sounds the class is on/i)).toBeInTheDocument();
  });

  it("counts the overlap when it is partial", () => {
    show({ classSounds: ["ʁ"] });
    expect(screen.getByText(/1 of these are what the class is on/i)).toBeInTheDocument();
  });
});

describe("the sentence that stops the hunt", () => {
  /**
   * Answered rather than left implicit. A teacher who is not told there is no
   * figure goes looking for one, which is the failure board 1a exists to
   * prevent and this screen can undo on its own.
   */
  it("says there is no figure on this page", () => {
    show();
    expect(screen.getByText(/which sounds, not how well/i)).toBeInTheDocument();
    expect(screen.getByText(/no figure on this page/i)).toBeInTheDocument();
  });

  it("says what the page offers instead", () => {
    show();
    expect(screen.getByText(/conversation and a device check/i)).toBeInTheDocument();
  });
});

describe("the microphone, not the pupil", () => {
  /**
   * The R8 indeterminate count. A take the app could not hear is never scored,
   * so this says nothing about how anybody spoke — which is exactly why it can
   * be shown to a teacher, and why the wording puts the device first.
   */
  it("reports a device worth checking, and blames the room rather than the pupil", () => {
    show({ row: row({ capture: { unusable: 6, total: 8 } }) });

    expect(screen.getByText(/6 of Ben’s last 8 takes came back unusable/)).toBeInTheDocument();
    expect(screen.getByText(/usually a microphone or a room, not a pupil/i)).toBeInTheDocument();
  });

  it("says a bad take was never counted against them", () => {
    show({ row: row({ capture: { unusable: 6, total: 8 } }) });

    expect(screen.getByText(/never scored and never counted against them/i)).toBeInTheDocument();
  });

  /**
   * Silence is the right output for a healthy device. A "microphone: fine"
   * line on every pupil is noise that makes the one that matters invisible.
   */
  it("says nothing at all when the device is fine", () => {
    show({ row: row({ capture: { unusable: 1, total: 8 } }) });

    expect(screen.queryByText(/worth knowing/i)).toBeNull();
  });

  it("says nothing when there is no sample to read", () => {
    show({ row: row({ capture: null }) });

    expect(screen.queryByText(/worth knowing/i)).toBeNull();
  });
});
