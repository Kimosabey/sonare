// @vitest-environment jsdom

/**
 * T13/FR-23 — the panel behind one word, and a lesson about honest feedback.
 *
 * This used to render "sound 1, sound 2, sound 3". Azure returns phonemes with
 * real accuracy scores and **empty labels** for every locale this product
 * ships — fr-FR, es-ES, de-DE, hi-IN — so the numbered row was true and
 * useless: a learner told sound 2 scored 61 has no way to know which sound
 * that was. Syllables carry a written grapheme instead.
 *
 * The phoneme row is kept rather than deleted because it is not universally
 * dead: en-US returns fully labelled phonemes, and the fixture runner can
 * select en-US. So the property under test is conditional rendering on
 * *label quality*, not on locale — a check on the data rather than a list of
 * languages someone has to remember to update.
 */

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PhonemeDetail } from "./PhonemeDetail.js";
import type { ScoredWord } from "../scoring/types.js";

/**
 * The visible grapheme on each chip. Each one is rendered twice on purpose —
 * once `aria-hidden` for the eye and once in an `sr-only` span for a screen
 * reader — so a plain text query legitimately finds two nodes.
 */
function visibleGraphemes(): string[] {
  return [...document.querySelectorAll(".sy-grapheme")].map((n) => n.textContent ?? "");
}

function syllable(grapheme: string, accuracy: number, offsetTicks = 0) {
  return { grapheme, accuracy, offsetTicks, durationTicks: 2_000_000 };
}

function word(overrides: Partial<ScoredWord> = {}): ScoredWord {
  return {
    word: "comment",
    accuracy: 77,
    errorType: "None",
    syllables: [syllable("com", 88), syllable("ment", 61, 2_000_000)],
    phonemes: [],
    ...overrides,
  } as ScoredWord;
}

afterEach(cleanup);

describe("syllables lead, because that is what the provider labels", () => {
  it("shows each syllable's written form", () => {
    render(<PhonemeDetail word={word()} />);

    expect(visibleGraphemes()).toEqual(["com", "ment"]);
  });

  it("renders for a word whose syllables are all unnamed", () => {
    /**
     * Hindi: every syllable measured is timed, none is named. The panel has to
     * be useful anyway — an ordinal plus a score plus tappable audio is the
     * whole of what a Hindi learner gets at this level.
     */
    render(
      <PhonemeDetail
        word={word({ syllables: [syllable("", 91), syllable("", 54, 2_000_000)] })}
        lang="hi-IN"
      />,
    );

    expect(document.querySelectorAll(".sy").length).toBe(2);
  });
});

describe("the phoneme row renders on label quality, not on locale", () => {
  it("stays hidden when the provider returned no labels", () => {
    /**
     * The four shipped locales. A row of "sound 1 / sound 2" beside syllables
     * that already say it better is worse than nothing: it is a second,
     * competing account of the same word that a learner cannot act on.
     */
    render(
      <PhonemeDetail
        word={word({
          phonemes: [
            { phoneme: "", accuracy: 88 },
            { phoneme: "", accuracy: 61 },
          ],
        })}
      />,
    );

    expect(document.querySelectorAll(".phonemes .p")).toHaveLength(0);
  });

  it("renders when the labels are real, as on en-US", () => {
    render(
      <PhonemeDetail
        word={word({
          phonemes: [
            { phoneme: "k", accuracy: 92 },
            { phoneme: "ə", accuracy: 71 },
          ],
        })}
      />,
    );

    expect(screen.getByText("k")).toBeInTheDocument();
    expect(screen.getByText("ə")).toBeInTheDocument();
  });

  it("drops only the unlabelled entries from a partially labelled set", () => {
    // A mixed response should not cost the labels that are real, nor show the
    // ones that are not.
    render(
      <PhonemeDetail
        word={word({
          phonemes: [
            { phoneme: "k", accuracy: 92 },
            { phoneme: "", accuracy: 40 },
            { phoneme: "m", accuracy: 80 },
          ],
        })}
      />,
    );

    expect(document.querySelectorAll(".phonemes .p")).toHaveLength(2);
    expect(screen.queryByText("40")).not.toBeInTheDocument();
  });

  it("bands each phoneme by its own score", () => {
    render(
      <PhonemeDetail
        word={word({
          phonemes: [
            { phoneme: "k", accuracy: 92 },
            { phoneme: "ə", accuracy: 71 },
            { phoneme: "m", accuracy: 40 },
          ],
        })}
      />,
    );

    const classes = [...document.querySelectorAll(".phonemes .p")].map((n) => n.className);
    expect(classes).toEqual(["p hi", "p mid", "p lo"]);
  });
});

describe("data restored from a saved session", () => {
  it("renders a word with no syllables field at all", () => {
    /**
     * The crash this guard exists for. A persisted session predates
     * `syllables` becoming required, and a type cannot make a claim about JSON
     * written before it existed — report.ts threw "word.syllables is not
     * iterable" on exactly this. The storage key is versioned now *and* the
     * consumption sites guard, because two defences is right for a value that
     * outlives its own type.
     */
    const stale = { word: "bonjour", accuracy: 88, errorType: "None" } as unknown as ScoredWord;

    expect(() => render(<PhonemeDetail word={stale} />)).not.toThrow();
  });

  it("renders a word with no phonemes field at all", () => {
    const stale = { word: "bonjour", accuracy: 88, syllables: [syllable("bon", 88)] } as unknown as ScoredWord;

    expect(() => render(<PhonemeDetail word={stale} />)).not.toThrow();
    expect(visibleGraphemes()).toEqual(["bon"]);
  });
});

describe("the error type", () => {
  it("names a real error, since it says what kind of mistake it was", () => {
    // Omission and mispronunciation call for different advice, and this is the
    // only place the distinction is shown.
    render(<PhonemeDetail word={word({ errorType: "Mispronunciation" })} />);

    expect(screen.getByText(/error type: Mispronunciation/)).toBeInTheDocument();
  });

  it('says nothing for "None", rather than reporting a non-error', () => {
    // Azure sends "None" for a correct word. Printing it would put a
    // red-flagged line under every word a learner got right.
    render(<PhonemeDetail word={word({ errorType: "None" })} />);

    expect(screen.queryByText(/error type/)).not.toBeInTheDocument();
  });

  it("says nothing when the field is absent", () => {
    render(<PhonemeDetail word={word({ errorType: undefined })} />);

    expect(screen.queryByText(/error type/)).not.toBeInTheDocument();
  });
});

describe("structure the parent depends on", () => {
  it("renders exactly one .phonemes container", () => {
    /**
     * WordChips asserts that exactly one expanded panel exists, and any second
     * element carrying this class counts as a second panel. This has already
     * broken once, when the phoneme row was moved into a nested container.
     */
    render(
      <PhonemeDetail
        word={word({ phonemes: [{ phoneme: "k", accuracy: 92 }] })}
      />,
    );

    expect(document.querySelectorAll(".phonemes")).toHaveLength(1);
  });

  it("carries the id the parent's aria-controls points at", () => {
    // Without it the expand/collapse relationship is invisible to a screen
    // reader, which is how the panel is reached at all.
    render(<PhonemeDetail word={word()} id="detail-comment" />);

    expect(document.querySelector(".phonemes")).toHaveAttribute("id", "detail-comment");
  });
});

describe("tapping a syllable", () => {
  it("passes the syllable and its index up for playback", () => {
    const onSelectSyllable = vi.fn();
    render(<PhonemeDetail word={word()} onSelectSyllable={onSelectSyllable} />);

    (document.querySelectorAll(".sy")[1] as HTMLElement).click();

    expect(onSelectSyllable).toHaveBeenCalledTimes(1);
    const [syl, index] = onSelectSyllable.mock.calls[0] as [{ grapheme: string }, number];
    expect(syl.grapheme).toBe("ment");
    expect(index).toBe(1);
  });

  it("renders static chips when there is no take to play", () => {
    // A tappable chip that does nothing is worse than one that is plainly not
    // tappable — the learner concludes the feature is broken.
    render(<PhonemeDetail word={word()} />);

    expect(document.querySelectorAll(".sy button")).toHaveLength(0);
  });
});
