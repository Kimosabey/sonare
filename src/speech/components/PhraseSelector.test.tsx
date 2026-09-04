// @vitest-environment jsdom

/**
 * The fixture runner's language and phrase picker, and one guard that protects
 * the measurement itself.
 *
 * Scoring French audio against an English reference produces a confidently
 * wrong number — not an error, a *score*, which then sits in the fixture
 * export looking exactly like every other result. PRD §8 says a contaminated
 * Set A invalidates the whole experiment, and this is one of the two ways to
 * contaminate it by accident. So changing language must swap the reference
 * text with it; leaving the old phrase in place would make that mistake a
 * single mis-click.
 *
 * Free entry stays available on purpose: §8's real Set A/B words are unlikely
 * to be exactly these ten activity sentences.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PhraseSelector } from "./PhraseSelector.js";
import { LANGUAGES } from "../../activities/languages/index.js";

const FRENCH = LANGUAGES.find((l) => l.code === "fr-FR");
const first = (code: string) => LANGUAGES.find((l) => l.code === code)?.activities[0]?.target ?? "";

function setup(props: Partial<Parameters<typeof PhraseSelector>[0]> = {}) {
  const onChange = vi.fn();
  render(
    <PhraseSelector
      language="fr-FR"
      referenceText={first("fr-FR")}
      onChange={onChange}
      {...props}
    />,
  );
  return { onChange };
}

afterEach(cleanup);

describe("changing language cannot leave a mismatched phrase", () => {
  it("swaps the reference text to the new language's first target", () => {
    /**
     * The guard that matters. Without it, selecting Spanish while a French
     * sentence sits in the box produces a real number for a comparison that
     * means nothing — and nothing downstream can tell it apart from a genuine
     * low score.
     */
    const { onChange } = setup();

    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "es-ES" } });

    expect(onChange).toHaveBeenCalledWith({
      language: "es-ES",
      referenceText: first("es-ES"),
    });
  });

  it("does it for every shipped language, not just the ones on screen first", () => {
    // Four languages ship. A per-language lookup that worked for two would
    // pass a spot check and contaminate the other two.
    for (const language of LANGUAGES) {
      cleanup();
      const { onChange } = setup();

      fireEvent.change(screen.getByLabelText("Language"), { target: { value: language.code } });

      const [call] = onChange.mock.calls[0] as [{ language: string; referenceText: string }];
      expect(call.language, language.code).toBe(language.code);
      expect(call.referenceText, language.code).toBe(language.activities[0]?.target);
      expect(call.referenceText, language.code).not.toBe("");
    }
  });

  it("offers every shipped language, with its code visible", () => {
    // The operator is recording against a locale, not a flag. "French · fr-FR"
    // is what lets them confirm the tag that actually reaches the provider.
    setup();

    for (const language of LANGUAGES) {
      expect(screen.getByRole("option", { name: `${language.label} · ${language.code}` })).toBeInTheDocument();
    }
  });
});

describe("the preloaded phrases", () => {
  it("lists the current language's targets", () => {
    setup();

    for (const activity of FRENCH?.activities ?? []) {
      expect(screen.getByRole("option", { name: activity.target })).toBeInTheDocument();
    }
  });

  it("selects a phrase without changing the language", () => {
    const second = FRENCH?.activities[1]?.target ?? "";
    const { onChange } = setup();

    fireEvent.change(screen.getByLabelText("Preloaded phrase"), { target: { value: second } });

    expect(onChange).toHaveBeenCalledWith({ language: "fr-FR", referenceText: second });
  });

  it("shows the phrase's focus note, which is how a low score gets read", () => {
    /**
     * Each activity records what sound it is designed to expose. During a run
     * that is the difference between "this speaker struggles with nasal
     * vowels" and "this recording scored 61".
     */
    setup();

    expect(screen.getByText(`Targets: ${FRENCH?.activities[0]?.focus ?? ""}`)).toBeInTheDocument();
  });

  it("shows no focus note for a phrase typed by hand", () => {
    // There is nothing true to say about a phrase the product does not know.
    setup({ referenceText: "Une phrase inventée" });

    expect(screen.queryByText(/^Targets:/)).not.toBeInTheDocument();
  });

  it("reads as Custom when the text matches no preset", () => {
    // The select must not keep pointing at a phrase that is no longer in the
    // box, which would misreport what is about to be scored.
    setup({ referenceText: "Une phrase inventée" });

    expect((screen.getByLabelText("Preloaded phrase") as HTMLSelectElement).value).toBe("__custom__");
  });

  it("does not clear the text when Custom is chosen deliberately", () => {
    /**
     * Choosing "Custom…" is a statement of intent, not an edit. Firing a
     * change that emptied the box would delete a phrase the operator had
     * already typed.
     */
    const { onChange } = setup({ referenceText: "Une phrase inventée" });

    fireEvent.change(screen.getByLabelText("Preloaded phrase"), { target: { value: "__custom__" } });

    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("free entry", () => {
  it("passes typed text straight through", () => {
    // PRD §8's real Set A/B words are unlikely to be these ten sentences.
    const { onChange } = setup();

    fireEvent.change(screen.getByLabelText(/Reference text/), { target: { value: "Bonjour" } });

    expect(onChange).toHaveBeenCalledWith({ language: "fr-FR", referenceText: "Bonjour" });
  });

  it("tags the field with the language being taught", () => {
    /**
     * WCAG 3.1.2, and something more practical on the device this screen
     * exists for: the `lang` tag steers the on-screen keyboard and the
     * spellchecker, so an operator typing French on a phone gets French
     * accents rather than a fight.
     */
    setup();

    expect(screen.getByLabelText(/Reference text/)).toHaveAttribute("lang", "fr-FR");
  });

  it("retags when the language changes", () => {
    cleanup();
    setup({ language: "hi-IN", referenceText: first("hi-IN") });

    expect(screen.getByLabelText(/Reference text/)).toHaveAttribute("lang", "hi-IN");
  });

  it("turns the spellchecker off", () => {
    // Red squiggles under every word of a correctly-spelled French sentence
    // train an operator to ignore the field they most need to read.
    setup();

    expect(screen.getByLabelText(/Reference text/)).toHaveAttribute("spellcheck", "false");
  });

  it("labels every control, since this screen is driven under time pressure", () => {
    setup();

    expect(screen.getByLabelText("Language")).toBeInTheDocument();
    expect(screen.getByLabelText("Preloaded phrase")).toBeInTheDocument();
    expect(screen.getByLabelText(/Reference text/)).toBeInTheDocument();
  });
});

describe("while a take is in flight", () => {
  it("disables every control", () => {
    /**
     * Changing the reference text mid-recording would score the take against
     * a phrase the speaker was never shown — and it would be recorded as a
     * legitimate attempt at the new phrase.
     */
    setup({ disabled: true });

    expect(screen.getByLabelText("Language")).toBeDisabled();
    expect(screen.getByLabelText("Preloaded phrase")).toBeDisabled();
    expect(screen.getByLabelText(/Reference text/)).toBeDisabled();
  });
});

describe("an unknown language", () => {
  it("falls back rather than rendering an empty picker", () => {
    // A stale value from a persisted session, or a hand-edited URL. An empty
    // phrase list would leave the operator with nothing to select.
    setup({ language: "xx-XX", referenceText: "" });

    expect(screen.getByLabelText("Preloaded phrase")).not.toBeDisabled();
    expect(screen.getAllByRole("option").length).toBeGreaterThan(LANGUAGES.length);
  });
});
