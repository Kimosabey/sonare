// @vitest-environment jsdom

/**
 * The two faces of an indeterminate result.
 *
 * Azure returns the same shape for "no speech" and "speech that matched
 * nothing in the target phrase": every word Omission, no phonemes. Recorded
 * evidence for why conflating them is expensive — one speaker, one session,
 * one microphone:
 *
 *   hi-IN (fluent)   full recognition, scored 93.4 / 96.4 / 99.4
 *   fr-FR (learning) "Je voudrais." out of a nine-word phrase, scored 23.2
 *
 * Shown only "couldn't get a clear read", that speaker went looking for a
 * microphone fault, and so did the debugging session that produced these
 * numbers — the audio turned out to be flawless throughout. These tests hold
 * the two messages apart so that regression cannot come back.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ScoreCard } from "./ScoreCard.js";
import type { PronunciationResult } from "../scoring/types.js";

// useCountUp reads prefers-reduced-motion, which jsdom does not implement.
// Report "no preference" so the scored branch renders its normal animation
// path rather than the reduced-motion shortcut.
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
});

/**
 * Explicit, because this project runs vitest without `globals: true` — which
 * is what Testing Library's auto-cleanup hooks into. Without it every render
 * accumulates in the same document and the second lookup of any repeated text
 * fails with "found multiple elements", which reads like a component bug
 * rather than a harness one.
 */
afterEach(cleanup);

const INDETERMINATE: PronunciationResult = {
  indeterminate: true,
  provider: "azure",
  reason: "no speech found to assess — every word was omitted",
};

const SCORED: PronunciationResult = {
  indeterminate: false,
  provider: "azure",
  recognized: "Bonjour, comment allez-vous",
  overall: 93,
  accuracy: 95,
  fluency: 90,
  completeness: 100,
  words: [],
};

describe("ScoreCard indeterminate handling", () => {
  it("says the audio was unclear when the capture layer heard nothing", () => {
    const { container } = render(<ScoreCard result={INDETERMINATE} heardSpeech={false} />);

    expect(screen.getByText("UNCLEAR")).toBeInTheDocument();
    expect(container.textContent).toMatch(/get a clear read/i);
  });

  it("says it could not match the phrase when the capture layer heard speech", () => {
    const { container } = render(<ScoreCard result={INDETERMINATE} heardSpeech />);

    expect(screen.getByText("NO MATCH")).toBeInTheDocument();
    expect(container.textContent).toMatch(/heard you clearly/i);
    // The wrong advice is the whole bug: never tell someone who spoke clearly
    // to be louder or to find a quieter room.
    expect(container.textContent).not.toMatch(/louder/i);
    expect(container.textContent).not.toMatch(/quieter/i);
  });

  it("defaults to the unclear wording when the caller says nothing", () => {
    const { container } = render(<ScoreCard result={INDETERMINATE} />);

    expect(screen.getByText("UNCLEAR")).toBeInTheDocument();
    expect(container.textContent).toMatch(/get a clear read/i);
  });

  it("never renders a number for an indeterminate result, either way — R8", () => {
    for (const heard of [true, false]) {
      const { container, unmount } = render(<ScoreCard result={INDETERMINATE} heardSpeech={heard} />);
      expect(container.textContent).not.toMatch(/\d/);
      unmount();
    }
  });

  it("still renders the scores when the result is usable", () => {
    const { container } = render(<ScoreCard result={SCORED} heardSpeech />);

    expect(screen.queryByText("UNCLEAR")).not.toBeInTheDocument();
    expect(screen.queryByText("NO MATCH")).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/get a clear read/i);
  });
});

describe("ScoreCard — the number that decides comes first", () => {
  it("leads with accuracy, which is what the pass gate reads", () => {
    // ActivityTest computes `passed = best >= PASS_SCORE` from
    // `result.accuracy`, and tells the learner "pass at 60" right below the
    // record button. If `overall` leads, a learner can read 71 against a
    // stated bar of 60 and still not advance, with nothing explaining why.
    const mixed: PronunciationResult = {
      indeterminate: false,
      provider: "azure",
      recognized: "Bonjour",
      overall: 71,
      accuracy: 58,
      fluency: 90,
      completeness: 88,
      words: [],
    };
    const { container } = render(<ScoreCard result={mixed} />);

    const labels = [...container.querySelectorAll(".overall .l")].map((e) => e.textContent);
    expect(labels[0]).toBe("accuracy");
  });

  it("still reports the other three, which diagnose rather than decide", () => {
    render(<ScoreCard result={SCORED} heardSpeech />);

    for (const label of ["accuracy", "overall", "fluency", "complete"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});

describe("ScoreCard — an unclear attempt is free", () => {
  it("tells the learner it did not cost a try", () => {
    // The code has always known this ("an indeterminate attempt does not burn
    // a try") and never said it. A learner who knows they get three tries
    // reasonably assumes UNCLEAR spent one.
    render(<ScoreCard result={INDETERMINATE} />);

    expect(screen.getByText(/didn’t count as an attempt/i)).toBeInTheDocument();
  });

  it("says it on the no-match branch too, where it is just as true", () => {
    render(<ScoreCard result={INDETERMINATE} heardSpeech />);

    expect(screen.getByText(/didn’t count as an attempt/i)).toBeInTheDocument();
  });

  it("does not say it on a scored attempt, which did count", () => {
    render(<ScoreCard result={SCORED} />);

    expect(screen.queryByText(/didn’t count as an attempt/i)).toBeNull();
  });
});
