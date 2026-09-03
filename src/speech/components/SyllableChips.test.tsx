// @vitest-environment jsdom
/**
 * Component coverage for SyllableChips.
 *
 * The load-bearing case is the unnamed syllable. hi-IN returns 0 graphemes
 * out of 108 across all ten of its activity targets while scoring and timing
 * every one, so for a whole language the positional label IS the feature —
 * a regression that blanks it, dashes it, or drops the score would look like
 * "Hindi is broken" rather than like a rendering bug. These tests pin the
 * three things that must never silently change: something is always shown
 * where a grapheme would go, the score is always reachable as text (not just
 * as a border colour), and the chips are only buttons when a handler exists.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SyllableChips } from "./SyllableChips.js";
import type { ScoredSyllable } from "../scoring/types.js";

// See RecordButton.test.tsx: no `globals: true` in vitest.config.ts, so
// Testing Library never registers its auto-cleanup and renders would
// otherwise accumulate in one jsdom document across tests.
afterEach(cleanup);

/** "Bonjour" from the live endpoint: bon 100, jour 93. */
const NAMED: ScoredSyllable[] = [
  { grapheme: "bon", accuracy: 100, offsetTicks: 400000, durationTicks: 2500000 },
  { grapheme: "jour", accuracy: 93, offsetTicks: 3000000, durationTicks: 5300000 },
];

/**
 * "allez-vous" from the same response: three syllables, all scored, none
 * named — Azure cannot map a grapheme across the hyphen. Shaped identically
 * to every Hindi word, which is why one fixture covers both.
 */
const UNNAMED: ScoredSyllable[] = [
  { grapheme: "", accuracy: 100, offsetTicks: 14000000, durationTicks: 2000000 },
  { grapheme: "", accuracy: 70, offsetTicks: 16000000, durationTicks: 2200000 },
  { grapheme: "", accuracy: 82, offsetTicks: 18200000, durationTicks: 2400000 },
];

describe("SyllableChips — named syllables", () => {
  it("shows each grapheme with its rounded score", () => {
    const { container } = render(<SyllableChips syllables={NAMED} />);

    /**
     * Queried by class rather than by text, because each grapheme is
     * deliberately in the DOM twice: once visibly (aria-hidden) and once
     * inside the accessible name, where it needs to be its own element to
     * carry `lang`. A plain getByText finds both and fails on the ambiguity,
     * which would say nothing about whether the component is correct.
     */
    const visible = [...container.querySelectorAll(".sy-grapheme")].map((e) => e.textContent);
    expect(visible).toEqual(["bon", "jour"]);

    const scores = [...container.querySelectorAll(".sy-score")].map((e) => e.textContent);
    expect(scores).toEqual(["100", "93"]);
  });

  it("tags only the grapheme with the language, never the sentence around it", () => {
    // WCAG 3.1.2. "jour, scored 93 out of 100" is one string with two
    // languages in it: tagging the whole thing would have a screen reader
    // pronounce "scored 93 out of 100" in French.
    const { container } = render(<SyllableChips syllables={NAMED} lang="fr-FR" />);

    const tagged = [...container.querySelectorAll('[lang="fr-FR"]')].map((e) => e.textContent);
    expect(tagged).toEqual(["bon", "bon", "jour", "jour"]);

    const name = container.querySelector(".sr-only");
    expect(name?.textContent).toBe("bon, scored 100 out of 100");
    expect(name?.querySelector('[lang="fr-FR"]')?.textContent).toBe("bon");
  });

  it("leaves the positional fallback untagged — an ordinal is English either way", () => {
    const { container } = render(
      <SyllableChips
        syllables={[{ grapheme: "", accuracy: 70, offsetTicks: 0, durationTicks: 10 }]}
        lang="hi-IN"
      />,
    );

    expect(container.querySelectorAll('[lang="hi-IN"]')).toHaveLength(0);
    expect(container.querySelector(".sr-only")?.textContent).toBe(
      "syllable 1 of 1, scored 70 out of 100",
    );
  });

  it("rounds a fractional accuracy for display", () => {
    render(<SyllableChips syllables={[{ grapheme: "ment", accuracy: 76.6, offsetTicks: 0, durationTicks: 10 }]} />);
    expect(screen.getByText("77")).toBeInTheDocument();
  });

  it("bands by the app-wide 80/60 thresholds, at the boundaries", () => {
    const { container } = render(
      <SyllableChips
        syllables={[
          { grapheme: "a", accuracy: 80, offsetTicks: 0, durationTicks: 1 },
          { grapheme: "b", accuracy: 79, offsetTicks: 1, durationTicks: 1 },
          { grapheme: "c", accuracy: 60, offsetTicks: 2, durationTicks: 1 },
          { grapheme: "d", accuracy: 59, offsetTicks: 3, durationTicks: 1 },
        ]}
      />,
    );

    const chips = container.querySelectorAll(".sy");
    expect(chips).toHaveLength(4);
    expect(chips[0]).toHaveClass("sy", "hi");
    expect(chips[1]).toHaveClass("sy", "mid");
    expect(chips[2]).toHaveClass("sy", "mid");
    expect(chips[3]).toHaveClass("sy", "lo");
  });

  it("does not explain positional labelling when the syllables are named", () => {
    const { container } = render(<SyllableChips syllables={NAMED} />);
    expect(container.querySelector(".sy-note")).toBeNull();
  });
});

describe("SyllableChips — unnamed syllables", () => {
  it("labels each one by ordinal position rather than leaving a gap", () => {
    const { container } = render(<SyllableChips syllables={UNNAMED} />);

    expect(screen.getByText("1st")).toBeInTheDocument();
    expect(screen.getByText("2nd")).toBeInTheDocument();
    expect(screen.getByText("3rd")).toBeInTheDocument();

    // Nothing empty, nothing dashed, nothing that reads as absent data.
    for (const pos of container.querySelectorAll(".sy-pos")) {
      expect(pos.textContent?.trim()).toMatch(/^\d+(st|nd|rd|th)$/);
    }
  });

  it("keeps ordinals correct past 3rd", () => {
    const four: ScoredSyllable[] = [0, 1, 2, 3].map((i) => ({
      grapheme: "",
      accuracy: 90,
      offsetTicks: i * 1000,
      durationTicks: 900,
    }));
    render(<SyllableChips syllables={four} />);
    expect(screen.getByText("4th")).toBeInTheDocument();
  });

  it("still shows every score, banded like a named chip", () => {
    const { container } = render(<SyllableChips syllables={UNNAMED} />);

    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("70")).toBeInTheDocument();
    expect(screen.getByText("82")).toBeInTheDocument();

    const chips = container.querySelectorAll(".sy");
    expect(chips[0]).toHaveClass("hi");
    expect(chips[1]).toHaveClass("mid");
    expect(chips[2]).toHaveClass("hi");
  });

  it("is not a visual variant of the named chip — same classes on the chip itself", () => {
    const { container: named } = render(<SyllableChips syllables={NAMED} />);
    const namedClass = named.querySelector(".sy")?.className;
    cleanup();
    const { container: unnamed } = render(<SyllableChips syllables={UNNAMED} />);
    expect(unnamed.querySelector(".sy")?.className).toBe(namedClass);
  });

  it("explains the positional labelling when NONE are named — the hi-IN case", () => {
    const { container } = render(<SyllableChips syllables={UNNAMED} />);
    const note = container.querySelector(".sy-note");
    expect(note).not.toBeNull();
    expect(note).toHaveTextContent(/labelled by position/);
  });

  it("stays silent in the mixed case, where the named chips make the pattern obvious", () => {
    const { container } = render(
      <SyllableChips
        syllables={[
          { grapheme: "", accuracy: 88, offsetTicks: 0, durationTicks: 1 },
          { grapheme: "pelle", accuracy: 91, offsetTicks: 1, durationTicks: 1 },
        ]}
      />,
    );
    expect(container.querySelector(".sy-note")).toBeNull();
    expect(screen.getByText("1st")).toBeInTheDocument();
  });
});

describe("SyllableChips — screen reader output", () => {
  it("announces a named syllable as its grapheme plus a score out of 100", () => {
    render(<SyllableChips syllables={NAMED} onSelect={vi.fn()} />);
    expect(screen.getByRole("button", { name: "jour, scored 93 out of 100" })).toBeInTheDocument();
  });

  it("announces an unnamed syllable with its position in the word, not a bare ordinal", () => {
    render(<SyllableChips syllables={UNNAMED} onSelect={vi.fn()} />);
    expect(screen.getByRole("button", { name: "syllable 2 of 3, scored 70 out of 100" })).toBeInTheDocument();
  });

  it("carries the same sentence when the chips are static, where aria-label would not be announced", () => {
    render(<SyllableChips syllables={UNNAMED} />);
    expect(screen.getByText("syllable 3 of 3, scored 82 out of 100")).toBeInTheDocument();
  });

  it("hides the terse visible label from assistive tech so it is not read twice", () => {
    const { container } = render(<SyllableChips syllables={NAMED} />);
    expect(container.querySelector(".sy-grapheme")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(".sy-score")).toHaveAttribute("aria-hidden", "true");
  });
});

describe("SyllableChips — the optional select handler", () => {
  it("renders static chips, with no controls, when no handler is given", () => {
    const { container } = render(<SyllableChips syllables={NAMED} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(container.querySelectorAll(".sy")).toHaveLength(2);
  });

  it("renders real, focusable buttons when a handler is given", () => {
    render(<SyllableChips syllables={NAMED} onSelect={vi.fn()} />);

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    for (const b of buttons) expect(b).toHaveAttribute("type", "button");

    // Keyboard reachability is the half of "visible focus state" that isn't
    // CSS: the ring comes from the global button:focus-visible rule, but only
    // if this is a genuinely focusable element.
    buttons[0]?.focus();
    expect(buttons[0]).toHaveFocus();
  });

  it("passes the whole syllable and its index — the ticks a replay needs", () => {
    const onSelect = vi.fn();
    render(<SyllableChips syllables={UNNAMED} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("button", { name: /syllable 2 of 3/ }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(UNNAMED[1], 1);
  });
});

describe("SyllableChips — no syllables at all", () => {
  it("says so plainly instead of rendering an empty row", () => {
    const { container } = render(<SyllableChips syllables={[]} />);

    expect(screen.getByText("no syllable detail returned for this word")).toBeInTheDocument();
    expect(container.querySelectorAll(".sy")).toHaveLength(0);
    // The positional legend is about unnamed syllables, not absent ones.
    expect(container.querySelector(".sy-note")).toBeNull();
  });

  it("accepts an id so a parent can point aria-controls at the panel", () => {
    const { container } = render(<SyllableChips syllables={NAMED} id="syllable-detail" />);
    expect(container.querySelector("#syllable-detail")).toHaveClass("syllables");
  });
});

describe("SyllableChips — replay affordance", () => {
  it("marks only the syllable currently sounding", () => {
    const { container } = render(
      <SyllableChips syllables={NAMED} onSelect={() => undefined} playingOffsetTicks={3000000} />,
    );

    const playing = container.querySelectorAll(".sy-playing");
    expect(playing).toHaveLength(1);
    // 3000000 ticks is "jour" in this fixture, not "bon".
    expect(playing[0]?.textContent).toContain("jour");
  });

  it("marks nothing when no syllable is sounding", () => {
    const { container } = render(
      <SyllableChips syllables={NAMED} onSelect={() => undefined} playingOffsetTicks={null} />,
    );

    expect(container.querySelectorAll(".sy-playing")).toHaveLength(0);
  });

  it("hands the tapped syllable back with its ticks, so the caller can slice the take", () => {
    const onSelect = vi.fn();
    render(<SyllableChips syllables={NAMED} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("button", { name: /jour/ }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    const [syllable, index] = onSelect.mock.calls[0] as unknown as [
      { grapheme: string; offsetTicks: number; durationTicks: number },
      number,
    ];
    expect(syllable.grapheme).toBe("jour");
    expect(syllable.offsetTicks).toBe(3000000);
    expect(syllable.durationTicks).toBe(5300000);
    expect(index).toBe(1);
  });

  it("states the affordance once for the group, not inside every chip's name", () => {
    // An accessible name should say what a control is, not how to operate it —
    // the button role already carries that. Repeating it per chip means a
    // screen reader user hears it once per syllable, every word.
    render(<SyllableChips syllables={NAMED} onSelect={() => undefined} />);

    expect(screen.getByText(/tap a syllable to hear it back/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "bon, scored 100 out of 100" })).toBeInTheDocument();
  });

  it("offers no affordance at all when there is nothing to play", () => {
    // available: false in useSyllablePlayback means no handler is passed, and
    // the chips must then be static rather than inviting a tap that does
    // nothing.
    render(<SyllableChips syllables={NAMED} />);

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/tap a syllable/i)).toBeNull();
  });
});
