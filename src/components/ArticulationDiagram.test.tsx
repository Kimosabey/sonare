// @vitest-environment jsdom

/**
 * The seam for the articulation diagrams, tested before the diagrams ship.
 *
 * Sixteen are generated and sitting outside the build because they are
 * unreviewed and ~890 KiB each. This component is what they land in, and the
 * properties below are the ones that decide whether landing them is safe.
 */

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { ArticulationDiagram } from "./ArticulationDiagram.js";
import { diagramFileFor } from "../activities/diagramFor.js";

afterEach(cleanup);

const ADVICE = "Keep your tongue tip down and make the sound at the back of your throat.";

describe("when there is a diagram", () => {
  it("shows it", () => {
    render(<ArticulationDiagram file="abc123.png" advice={ADVICE} />);

    expect(screen.getByRole("presentation")).toHaveAttribute("src", "/diagrams/abc123.png");
  });

  /**
   * Decorative, and that is a judgement rather than laziness. The advice it
   * illustrates is already on screen in words; an `alt` attempting to describe
   * a tongue position would be a worse version of that sentence, read twice.
   * The instruction stays in text, where it is translatable and selectable.
   */
  it("is decorative, because the instruction is already in words", () => {
    render(<ArticulationDiagram file="abc123.png" advice={ADVICE} />);

    const img = screen.getByRole("presentation");
    expect(img).toHaveAttribute("alt", "");
    expect(img.getAttribute("aria-label")).toBeNull();
  });

  /** Sized, so nothing reflows when a 320px image arrives late. */
  it("reserves its space before it loads", () => {
    render(<ArticulationDiagram file="abc123.png" advice={ADVICE} />);

    const img = screen.getByRole("presentation");
    expect(img).toHaveAttribute("width");
    expect(img).toHaveAttribute("height");
    expect(img).toHaveAttribute("loading", "lazy");
  });
});

describe("when there is not", () => {
  /**
   * Nothing at all, never a placeholder. A missing diagram is a gap in our
   * description of a sound rather than a fact about it, and a grey box where a
   * mouth should be reads as the app being broken — the one impression a
   * learner mid-take cannot afford.
   */
  it.each([null, ""])("renders nothing for %p", (file) => {
    const { container } = render(<ArticulationDiagram file={file} advice={ADVICE} />);

    expect(container).toBeEmptyDOMElement();
  });

  /**
   * And refuses to be the only instruction. A picture with no words beside it
   * cannot be read aloud, translated or selected — so if the advice is gone,
   * the diagram goes with it rather than standing alone.
   */
  it("renders nothing when it would be the only instruction", () => {
    const { container } = render(<ArticulationDiagram file="abc123.png" advice="  " />);

    expect(container).toBeEmptyDOMElement();
  });
});

describe("naming the file", () => {
  /**
   * The same hash the generator uses. A renamed file and a changed IPA are the
   * same event, and both must produce a miss rather than a stale picture of
   * the wrong sound.
   */
  it("matches the generator for a known sound", async () => {
    // /ʁ/ — the hash the generator wrote when this was first run.
    expect(await diagramFileFor("/ʁ/")).toBe("ab886e073b617e07.png");
  });

  it("gives different sounds different files", async () => {
    const one = await diagramFileFor("/ʁ/");
    const two = await diagramFileFor("/x/");

    expect(one).not.toBe(two);
    expect(one).not.toBeNull();
  });

  it("names nothing for an empty sound", async () => {
    expect(await diagramFileFor("")).toBeNull();
    expect(await diagramFileFor("   ")).toBeNull();
  });
});
