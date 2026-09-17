// @vitest-environment jsdom

/**
 * The vowel chart — Session board 1j.
 *
 * Two properties carry everything, and both are about what a chart of somebody's
 * mouth is allowed to claim.
 *
 * **It is a measurement, not a grade.** The board says so twice. Nothing may be
 * banded, coloured by accuracy or called good: a position is something a learner
 * can act on, a score is something they can only feel, and a score colour on a
 * position turns "your tongue is here" into "you did badly".
 *
 * **It does not draw what it cannot measure.** Whenever the estimator refuses —
 * most importantly for a voice pitched above what the method handles, which is
 * most women and all children — there is no point. Drawing that one would tell
 * a learner to move their mouth toward the wrong vowel.
 */

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { VowelChart, describeGap } from "./VowelChart.js";
import type { FormantMeasurement } from "../speech/capture/formants.js";

/**
 * Typed as the measured variant rather than the union, so a case can spread it
 * and override a spread value without losing the narrowing.
 */
function measured(f1Hz: number, f2Hz: number): FormantMeasurement {
  return {
    kind: "measured",
    f1Hz,
    f2Hz,
    f1SpreadHz: 4,
    f2SpreadHz: 6,
    framesMeasured: 17,
    framesTotal: 17,
  };
}

const TARGET = { ipa: "ɛ", f1Hz: 530, f2Hz: 1840 };

afterEach(cleanup);

describe("what it draws", () => {
  it("plots the learner and the target, and the gap between them", () => {
    const { container } = render(
      <VowelChart outcome={measured(650, 1500)} target={TARGET} grapheme="drais" />,
    );

    expect(container.querySelector(".vowel-you")).toBeInTheDocument();
    expect(container.querySelector(".vowel-target")).toBeInTheDocument();
    // The gap is the instruction, drawn rather than left to be inferred.
    expect(container.querySelector(".vowel-gap")).toBeInTheDocument();
    /**
     * And the width of the answer. The estimator's own docs say a chart should
     * draw "an area rather than a dot", because an estimate presented as a
     * point is presented as exact.
     */
    expect(container.querySelector(".vowel-you-spread")).toBeInTheDocument();
  });

  it("names the syllable it is about", () => {
    render(<VowelChart outcome={measured(650, 1500)} target={TARGET} grapheme="drais" />);
    expect(screen.getByRole("heading", { name: /drais/ })).toBeInTheDocument();
  });

  /**
   * The axes are the phonetician's, and the labels are the learner's: they
   * move a mouth, not a frequency. F2 rising leftward is what makes the left
   * edge "front"; F1 rising downward is what makes the bottom "open".
   */
  it("labels the axes as mouth positions rather than frequencies", () => {
    render(<VowelChart outcome={measured(650, 1500)} target={TARGET} grapheme="drais" />);

    for (const label of ["Front", "Back", "CLOSE", "OPEN"]) {
      expect(screen.getByText(label), label).toBeInTheDocument();
    }
    expect(screen.queryByText(/Hz|F1|F2/)).not.toBeInTheDocument();
  });

  it("says it is a position rather than a mark", () => {
    render(<VowelChart outcome={measured(650, 1500)} target={TARGET} grapheme="drais" />);
    expect(screen.getByText(/a position, not a mark/i)).toBeInTheDocument();
  });

  /**
   * A chart is the one thing on this screen a screen reader cannot use, and it
   * carries the only actionable information — so the instruction has to be in
   * the label, not only in the drawing.
   */
  it("puts the instruction in the accessible label, not only in the picture", () => {
    render(<VowelChart outcome={measured(650, 1500)} target={TARGET} grapheme="drais" />);

    const plot = screen.getByRole("img");
    expect(plot).toHaveAccessibleName(/drais/);
    expect(plot.getAttribute("aria-label")).toMatch(/further forward|further back|more open|tighter|very close/);
  });

  /**
   * A wider spread is a wider ellipse. Without this the area could be a fixed
   * decoration that looks like honesty while saying nothing.
   */
  it("draws a larger area for a less certain estimate", () => {
    const tight = render(
      <VowelChart
        outcome={{ ...measured(650, 1500), f1SpreadHz: 2, f2SpreadHz: 3 }}
        target={TARGET}
        grapheme="a"
      />,
    );
    const tightRy = Number(
      tight.container.querySelector(".vowel-you-spread")?.getAttribute("ry") ?? 0,
    );
    cleanup();

    const loose = render(
      <VowelChart
        outcome={{ ...measured(650, 1500), f1SpreadHz: 80, f2SpreadHz: 150 }}
        target={TARGET}
        grapheme="a"
      />,
    );
    const looseRy = Number(
      loose.container.querySelector(".vowel-you-spread")?.getAttribute("ry") ?? 0,
    );

    expect(looseRy).toBeGreaterThan(tightRy);
  });

  it("draws the learner alone when the content names no target", () => {
    const { container } = render(
      <VowelChart outcome={measured(650, 1500)} target={null} grapheme="drais" />,
    );

    expect(container.querySelector(".vowel-you")).toBeInTheDocument();
    expect(container.querySelector(".vowel-target")).not.toBeInTheDocument();
    expect(container.querySelector(".vowel-gap")).not.toBeInTheDocument();
  });

  it("shows how the sound is made when that is authored", () => {
    render(
      <VowelChart
        outcome={measured(650, 1500)}
        target={TARGET}
        grapheme="drais"
        howItIsMade="Tongue high and forward, lips relaxed."
      />,
    );

    expect(screen.getByText(/Tongue high and forward/)).toBeInTheDocument();
  });
});

describe("what it refuses to draw", () => {
  /**
   * The one that matters most. Above roughly 140 Hz of fundamental this method
   * returns F1 wrong by hundreds of Hz and *confidently* — so the chart shows
   * nothing rather than a point on the wrong vowel.
   */
  it("draws nothing for a voice it cannot measure, and says whose fault that is not", () => {
    const { container } = render(
      <VowelChart outcome={{ kind: "refused", reason: "pitch-too-high" }} target={TARGET} grapheme="drais" />,
    );

    expect(container.querySelector(".vowel-you")).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing is wrong with your take/i)).toBeInTheDocument();
  });

  it.each(["not-voiced", "no-resonance", "unstable", "too-short"] as const)(
    "draws nothing when the estimator refuses with %s",
    (reason) => {
      const { container } = render(
        <VowelChart outcome={{ kind: "refused", reason }} target={TARGET} grapheme="drais" />,
      );

      expect(container.querySelector("svg")).not.toBeInTheDocument();
      // And says something, rather than rendering an empty box.
      expect(screen.getByRole("status").textContent?.trim().length).toBeGreaterThan(20);
    },
  );
});

describe("it is a measurement, not a grade", () => {
  /**
   * No banding, anywhere. `band()` returns hi/mid/lo and colours everything
   * else in the product; a chart wearing those classes would be read as a
   * verdict on the learner rather than a position of their tongue.
   */
  it("uses no score band and no accuracy colour", () => {
    const { container } = render(
      <VowelChart outcome={measured(650, 1500)} target={TARGET} grapheme="drais" />,
    );

    /**
     * Class *tokens*, not substrings. The first version of this searched for
     * `class="hi` and matched `class="hint"` — a false positive about the one
     * property the chart most needs held honestly.
     */
    const banned = new Set(["hi", "mid", "lo", "v-pass", "v-fail", "v-warn"]);
    const worn: string[] = [];
    for (const el of container.querySelectorAll("*")) {
      for (const token of el.classList) {
        if (banned.has(token)) worn.push(`${el.tagName.toLowerCase()}.${token}`);
      }
    }

    expect(worn, `score bands on the chart: ${worn.join(", ")}`).toEqual([]);
  });

  it("shows no number anywhere on the chart", () => {
    render(<VowelChart outcome={measured(650, 1500)} target={TARGET} grapheme="drais" />);

    // The landmarks and labels are letters and words; a figure would read as a
    // score however it was framed.
    expect(screen.queryByText(/\b\d{2,}\b/)).not.toBeInTheDocument();
  });
});

describe("the gap, as a sentence", () => {
  it("says further forward when the vowel is too far back", () => {
    expect(describeGap(530, 1400, TARGET)).toMatch(/further forward/);
  });

  it("says further back when it is too far forward", () => {
    expect(describeGap(530, 2300, TARGET)).toMatch(/further back/);
  });

  it("says more open when the jaw is too closed", () => {
    expect(describeGap(400, 1840, TARGET)).toMatch(/more open/);
  });

  it("combines both when both are out", () => {
    const said = describeGap(400, 1400, TARGET);
    expect(said).toMatch(/further forward/);
    expect(said).toMatch(/more open/);
  });

  /**
   * A difference too small to say out loud is too small to draw an instruction
   * from. Telling a learner to adjust something they have already got right is
   * how a corrective screen loses their trust.
   */
  it("says it is close rather than inventing an adjustment", () => {
    expect(describeGap(535, 1850, TARGET)).toMatch(/very close/i);
  });

  it("says nothing at all when there is no target", () => {
    expect(describeGap(530, 1840, null)).toBe("");
  });
});
