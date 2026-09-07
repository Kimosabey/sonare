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

/**
 * Phonemes carry a label here only because these are hand-made fixtures; real
 * responses return them empty for every locale Sonare ships. The syllables are
 * shaped like the real thing instead: "Bonjour" named, "allez" unnamed — the
 * elision/hyphenation case Azure cannot map a grapheme across.
 */
const WORDS: ScoredWord[] = [
  {
    word: "Bonjour",
    accuracy: 85,
    errorType: "None",
    phonemes: [{ phoneme: "b", accuracy: 90 }],
    syllables: [
      { grapheme: "bon", accuracy: 100, offsetTicks: 400000, durationTicks: 2500000 },
      { grapheme: "jour", accuracy: 93, offsetTicks: 3000000, durationTicks: 5300000 },
    ],
  },
  {
    word: "comment",
    accuracy: 65,
    errorType: "Mispronunciation",
    phonemes: [{ phoneme: "k", accuracy: 65 }],
    syllables: [
      { grapheme: "com", accuracy: 100, offsetTicks: 9000000, durationTicks: 2000000 },
      { grapheme: "ment", accuracy: 77, offsetTicks: 11000000, durationTicks: 2400000 },
    ],
  },
  {
    word: "allez",
    accuracy: 40,
    errorType: "Mispronunciation",
    phonemes: [{ phoneme: "a", accuracy: 40 }],
    syllables: [{ grapheme: "", accuracy: 40, offsetTicks: 14000000, durationTicks: 3000000 }],
  },
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

/**
 * "You didn't say it" against "you said it badly".
 *
 * Azure's miscue detection returns an omitted word as `Omission` with accuracy
 * 0 — arithmetically identical to a word said very badly, and until this change
 * rendered identically: a red chip reading "0". They call for opposite
 * actions, and a learner shown 0 on a word they skipped reasonably concludes
 * their pronunciation of it was terrible.
 *
 * 57 of the 401 words in the stored trail are omissions, which makes this the
 * commonest fault in the data rather than an edge case.
 */
describe("what a word's mark actually claims", () => {
  function chipFor(word: string): HTMLElement {
    const found = [...document.querySelectorAll(".word")].find((n) =>
      (n.querySelector("span[lang]")?.textContent ?? "") === word,
    );
    if (!found) throw new Error(`no chip for "${word}"`);
    return found as HTMLElement;
  }

  function mark(word: string): string {
    return chipFor(word).querySelector("small")?.textContent ?? "";
  }

  const phrase: ScoredWord[] = [
    { word: "Bonjour", accuracy: 95, errorType: "None", phonemes: [], syllables: [] },
    { word: "comment", accuracy: 41, errorType: "Mispronunciation", phonemes: [], syllables: [] },
    { word: "allez", accuracy: 0, errorType: "Omission", phonemes: [], syllables: [] },
    { word: "beaucoup", accuracy: 30, errorType: "Insertion", phonemes: [], syllables: [] },
  ];

  it("shows no score for a word that was never said", () => {
    /**
     * A dash, not a zero. Zero out of a hundred is a claim about pronunciation,
     * and nothing measured this word's pronunciation — there was no audio of
     * it to measure. R8's reasoning at the level of one chip.
     */
    render(<WordChips words={phrase} lang="fr-FR" />);

    expect(mark("allez")).toBe("—");
    expect(mark("allez")).not.toContain("0");
  });

  it("still shows the score for a word that was said badly", () => {
    // The distinction is the point: 41 is real information about "comment",
    // and hiding it would remove the reason the learner should retry.
    render(<WordChips words={phrase} lang="fr-FR" />);

    expect(mark("comment")).toBe("41");
    expect(mark("Bonjour")).toBe("95");
  });

  it("marks a word that was said but not asked for", () => {
    // Scoring an inserted word against a phrase it is not in would be scoring
    // the wrong thing.
    render(<WordChips words={phrase} lang="fr-FR" />);

    expect(mark("beaucoup")).toBe("+");
  });

  it("tells a screen reader what the mark means", () => {
    /**
     * The dash carries the meaning visually and carries nothing at all to a
     * reader. "Not said" is the entire content of that chip for anyone who
     * cannot see that the number is missing.
     */
    render(<WordChips words={phrase} lang="fr-FR" />);

    expect(chipFor("allez").textContent).toContain("not said");
    expect(chipFor("beaucoup").textContent).toContain("extra");
    // And says nothing extra where the score speaks for itself.
    expect(chipFor("Bonjour").textContent).not.toContain("not said");
  });

  it("bands an omission as a fault regardless of its score", () => {
    // Banding by an accuracy of 0 would happen to look right; banding by the
    // error type is right for the reason, and survives a provider that
    // reports an omission with some other number.
    render(
      <WordChips
        words={[{ word: "allez", accuracy: 88, errorType: "Omission", phonemes: [], syllables: [] }]}
        lang="fr-FR"
      />,
    );

    expect(chipFor("allez").className).toContain("lo");
  });

  it("does not band an insertion as a failure", () => {
    /**
     * An extra word is not a badly pronounced one. Colouring it as a failure
     * would tell a learner they said "beaucoup" wrong, when the only issue is
     * that "beaucoup" is not in this phrase.
     */
    render(<WordChips words={phrase} lang="fr-FR" />);

    expect(chipFor("beaucoup").className).toContain("mid");
    expect(chipFor("beaucoup").className).not.toContain("lo");
  });

  it("falls back to the score for an error type this build has not seen", () => {
    // The contract types `errorType` as a union plus `string`, deliberately —
    // a provider can add one, and an unknown type must not blank the score.
    render(
      <WordChips
        words={[{ word: "mot", accuracy: 72, errorType: "SomethingNew", phonemes: [], syllables: [] }]}
        lang="fr-FR"
      />,
    );

    expect(mark("mot")).toBe("72");
  });

  it("still opens the detail panel for an omitted word", () => {
    // Tapping it is how a learner hears the model pronunciation of a word they
    // skipped, which is the most useful thing they can do about it.
    render(<WordChips words={phrase} lang="fr-FR" />);

    fireEvent.click(chipFor("allez"));

    expect(document.querySelectorAll(".phonemes")).toHaveLength(1);
  });
});
