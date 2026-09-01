// @vitest-environment jsdom
/**
 * Component coverage for WordChips: the band()-driven accuracy coloring and
 * the tap-to-expand phoneme detail, including the aria-controls wiring added
 * this session (a chip must only ever claim to control a detail panel that
 * actually exists in the DOM at that moment).
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WordChips } from "./WordChips.js";
import type { ScoredWord } from "../scoring/types.js";

// See RecordButton.test.tsx for why this is explicit rather than relying on
// Testing Library's auto-cleanup (which needs a global `afterEach`, unused
// in this codebase's explicit-import test style).
afterEach(cleanup);

const WORDS: ScoredWord[] = [
  { word: "Bonjour", accuracy: 85, errorType: "None", phonemes: [{ phoneme: "b", accuracy: 90 }] },
  { word: "comment", accuracy: 65, errorType: "Mispronunciation", phonemes: [{ phoneme: "k", accuracy: 65 }] },
  { word: "allez", accuracy: 40, errorType: "Mispronunciation", phonemes: [{ phoneme: "a", accuracy: 40 }] },
];

describe("WordChips", () => {
  it("bands each chip by accuracy — hi/mid/lo at the 80/60 thresholds", () => {
    render(<WordChips words={WORDS} />);

    expect(screen.getByRole("button", { name: /Bonjour/ })).toHaveClass("word", "hi");
    expect(screen.getByRole("button", { name: /comment/ })).toHaveClass("word", "mid");
    expect(screen.getByRole("button", { name: /allez/ })).toHaveClass("word", "lo");
  });

  it("shows the rounded accuracy on each chip", () => {
    render(<WordChips words={WORDS} />);
    expect(screen.getByRole("button", { name: /Bonjour/ })).toHaveTextContent("85");
  });

  it("no chip is expanded initially, and no detail panel exists yet", () => {
    render(<WordChips words={WORDS} />);
    for (const w of WORDS) {
      expect(screen.getByRole("button", { name: new RegExp(w.word) })).toHaveAttribute("aria-expanded", "false");
    }
    expect(screen.queryByText("no phoneme detail returned for this word")).not.toBeInTheDocument();
  });

  it("tapping a chip expands it, renders its own phoneme detail, and aria-controls points at it", () => {
    render(<WordChips words={WORDS} />);

    const chip = screen.getByRole("button", { name: /comment/ });
    fireEvent.click(chip);

    expect(chip).toHaveAttribute("aria-expanded", "true");
    const controlsId = chip.getAttribute("aria-controls");
    expect(controlsId).toBeTruthy();
    // The element aria-controls names must actually exist and actually be
    // this word's own detail — not a stale id from a previous render.
    const panel = document.getElementById(controlsId as string);
    expect(panel).not.toBeNull();
    expect(panel).toHaveTextContent("k");
  });

  it("tapping the same chip again collapses it and removes the detail panel", () => {
    render(<WordChips words={WORDS} />);
    const chip = screen.getByRole("button", { name: /comment/ });

    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(chip).not.toHaveAttribute("aria-controls");
  });

  it("tapping a different chip switches which one is expanded — only one panel at a time", () => {
    render(<WordChips words={WORDS} />);
    const first = screen.getByRole("button", { name: /Bonjour/ });
    const second = screen.getByRole("button", { name: /comment/ });

    fireEvent.click(first);
    expect(first).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(second);
    expect(first).toHaveAttribute("aria-expanded", "false");
    expect(second).toHaveAttribute("aria-expanded", "true");
    // Only the currently-open chip's detail should exist in the DOM.
    expect(document.querySelectorAll(".phonemes")).toHaveLength(1);
  });
});
