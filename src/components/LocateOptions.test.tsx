// @vitest-environment jsdom

/**
 * The options for "which sound was in that?".
 *
 * The property that decides whether this is a listening exercise at all: the
 * phrase contains the answer, so it must not be on screen until the question
 * is over. The `listen` kind shipped once with written French options and
 * could be answered with the audio muted; this is the same trap one step over.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocateOptions } from "./LocateOptions.js";
import type { LocateOption } from "../activities/locate.js";

afterEach(cleanup);

const OPTIONS: LocateOption[] = [
  { grapheme: "bon", correct: false },
  { grapheme: "vou", correct: true },
  { grapheme: "mer", correct: false },
  { grapheme: "plaît", correct: false },
];

function show(over: Partial<Parameters<typeof LocateOptions>[0]> = {}) {
  const onChoose = over.onChoose ?? vi.fn();
  render(
    <LocateOptions
      options={OPTIONS}
      code="fr-FR"
      target="je voudrais un café"
      onChoose={onChoose}
      {...over}
    />,
  );
  return { onChoose };
}

describe("it cannot be answered by reading", () => {
  /**
   * The whole exercise. The answer is a syllable *of the phrase*, so the
   * phrase on screen is the answer on screen.
   */
  it("does not show the phrase before the question is answered", () => {
    show();

    expect(screen.queryByText("je voudrais un café")).toBeNull();
  });

  it("shows it once answered, with the syllable named", () => {
    show({ chosen: "vou" });

    expect(screen.getByText("je voudrais un café")).toBeInTheDocument();
    expect(screen.getByText(/is in it/)).toBeInTheDocument();
  });

  /**
   * The options are syllables of the language being learnt, so they carry
   * `lang` — a screen reader saying "vou" with an English voice is reading a
   * different sound from the one being asked about.
   */
  it("marks every option as the content language", () => {
    show();

    for (const option of OPTIONS) {
      expect(screen.getByText(option.grapheme)).toHaveAttribute("lang", "fr-FR");
    }
  });
});

describe("answering", () => {
  it("reports the syllable chosen", () => {
    const { onChoose } = show();

    fireEvent.click(screen.getByRole("button", { name: /vou/ }));
    expect(onChoose).toHaveBeenCalledWith("vou");
  });

  /**
   * One answer. With four options a second guess is worth a third of a right
   * answer, and the exercise becomes elimination rather than hearing.
   */
  it("takes no second answer", () => {
    const { onChoose } = show({ chosen: "bon" });

    for (const option of OPTIONS) {
      expect(screen.getByRole("button", { name: new RegExp(option.grapheme) })).toBeDisabled();
    }

    fireEvent.click(screen.getByRole("button", { name: /vou/ }));
    expect(onChoose).not.toHaveBeenCalled();
  });

  /**
   * The outcome is a word as well as a mark. A tick cannot say "correct" to
   * somebody who cannot see it, and colour is never the only carrier here.
   */
  it("says the outcome in words, not only as a glyph", () => {
    show({ chosen: "bon" });

    expect(screen.getByText(/— correct/)).toBeInTheDocument();
    expect(screen.getByText(/— not in the phrase/)).toBeInTheDocument();
  });

  it("marks the right answer even when a wrong one was picked", () => {
    show({ chosen: "bon" });

    const answer = screen.getByRole("button", { name: /vou/ });
    expect(answer.className).toContain("is-answer");
  });

  /**
   * Nothing is marked before an answer. A screen that showed the answer's
   * styling early would give it away to anybody watching the colours.
   */
  it("marks nothing before an answer", () => {
    show();

    expect(screen.queryByText(/— correct/)).toBeNull();
    for (const option of OPTIONS) {
      const button = screen.getByRole("button", { name: new RegExp(option.grapheme) });
      expect(button.className).not.toContain("is-answer");
    }
  });
});
