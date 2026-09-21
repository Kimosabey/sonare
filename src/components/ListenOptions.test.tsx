// @vitest-environment jsdom

/**
 * The listening question's options — the one options component with no test.
 *
 * Its sibling `LocateOptions` has had one since it was written. This did not,
 * and the gap was hidden by the kind itself being unreachable: `listen` ships
 * in no course, so nothing rendered this in anger and nothing missed it.
 *
 * The properties below are the ones the component's own comments argue for,
 * which is the right set to pin — each is a decision somebody made against an
 * obvious alternative, and each is invisible once the code is read quickly.
 *
 *  - **The right answer is marked whether or not the learner found it.**
 *    Showing "wrong" without showing what was right leaves somebody knowing
 *    they failed and not what they missed, which is the one thing this
 *    activity exists to teach.
 *  - **The target is revealed only after answering.** Before that it *is* the
 *    answer.
 *  - **The options carry no `lang`, and the revealed phrase does.** These
 *    options are English meanings; tagging them would have a screen reader
 *    read English in a French voice — the mirror of the mistake WCAG 3.1.2
 *    exists to prevent.
 *  - **One option renders nothing.** A single always-right button teaches
 *    nothing.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ListenOptions } from "./ListenOptions.js";
import type { ListenOption } from "../activities/listen.js";

afterEach(cleanup);

const OPTIONS: ListenOption[] = [
  { id: "a", text: "I would like a coffee", correct: true },
  { id: "b", text: "I would like a tea", correct: false },
];

const TARGET = "Je voudrais un café";

function show(over: Partial<Parameters<typeof ListenOptions>[0]> = {}) {
  const onChoose = vi.fn();
  render(
    <ListenOptions
      options={OPTIONS}
      code="fr-FR"
      target={TARGET}
      focus="The vowel in café is not the one in tea."
      chosen={null}
      onChoose={onChoose}
      {...over}
    />,
  );
  return { onChoose };
}

const list = () => screen.getByRole("list", { name: /which phrase/i });

describe("while the question is open", () => {
  it("offers every option as something to press", () => {
    show();

    const buttons = within(list()).getAllByRole("button");
    expect(buttons).toHaveLength(OPTIONS.length);
    for (const button of buttons) expect(button).toBeEnabled();
  });

  /**
   * The target is the answer. Revealing it before the learner chooses would
   * make the activity a reading exercise with the answer printed above it.
   */
  it("does not show the phrase that is being asked about", () => {
    show();

    expect(screen.queryByText(TARGET)).toBeNull();
  });

  it("marks nothing right or wrong before an answer", () => {
    show();

    expect(screen.queryByLabelText(/correct/i)).toBeNull();
    expect(screen.queryByLabelText(/what you picked/i)).toBeNull();
  });

  it("hands back the option that was pressed, not its index", () => {
    const { onChoose } = show();

    fireEvent.click(within(list()).getByText("I would like a tea").closest("button")!);

    expect(onChoose).toHaveBeenCalledWith(OPTIONS[1]);
  });
});

describe("once answered", () => {
  /**
   * The load-bearing one. A learner who picked wrong must be shown which was
   * right — the component's own comment makes this argument and nothing held
   * it.
   */
  it("marks the right answer even when the learner did not find it", () => {
    show({ chosen: "b" });

    const right = within(list()).getByText("I would like a coffee").closest("button")!;

    expect(within(right).getByLabelText("correct")).toBeInTheDocument();
    /**
     * And the visual state, not only the screen-reader one.
     *
     * The first version checked the tick alone, and a mutant that marked the
     * right answer only when the learner had picked it survived — because it
     * changed the class and left the tick. Motion and colour are never the
     * only carrier here, which cuts both ways: neither is the label. Both have
     * to be right or one audience is served and the other is not.
     */
    expect(right.className).toMatch(/is-correct/);
  });

  it("also marks what they picked, so the two are distinguishable", () => {
    show({ chosen: "b" });

    const picked = within(list()).getByText("I would like a tea").closest("button")!;
    expect(within(picked).getByLabelText("what you picked")).toBeInTheDocument();
    expect(picked).toHaveAttribute("aria-pressed", "true");
  });

  /**
   * And marks the right one once, not twice, when they did find it — a "✓" and
   * a "✕" on the same button would say both things at once.
   */
  it("marks a correct choice as correct and not also as a mistake", () => {
    show({ chosen: "a" });

    const chosen = within(list()).getByText("I would like a coffee").closest("button")!;
    expect(within(chosen).getByLabelText("correct")).toBeInTheDocument();
    expect(within(chosen).queryByLabelText("what you picked")).toBeNull();
  });

  it("stops taking answers", () => {
    show({ chosen: "a" });

    for (const button of within(list()).getAllByRole("button")) expect(button).toBeDisabled();
  });

  it("reveals the phrase and what separated it from the near miss", () => {
    show({ chosen: "b" });

    expect(screen.getByText(TARGET)).toBeInTheDocument();
    expect(screen.getByText(/vowel in café/i)).toBeInTheDocument();
  });

  /**
   * The revealed phrase carries `lang`; the options do not. Tagging the
   * English options would have a screen reader read them in a French voice —
   * the mirror of the mistake WCAG 3.1.2 exists to prevent.
   */
  it("tags the phrase with its language and leaves the English options untagged", () => {
    show({ chosen: "b" });

    expect(screen.getByText(TARGET)).toHaveAttribute("lang", "fr-FR");
    /**
     * Searched downward, not up.
     *
     * The first version asked `button.closest("[lang]")`, which walks
     * *ancestors* — so tagging the span inside each button changed nothing it
     * could see, and the mutant that put French on the English options
     * survived. The tag would be on or under the button, never above it.
     */
    for (const button of within(list()).getAllByRole("button")) {
      expect(button.hasAttribute("lang"), button.textContent ?? "").toBe(false);
      expect(button.querySelector("[lang]")).toBeNull();
    }
  });
});

describe("content it refuses to render", () => {
  /**
   * The publish gate refuses these and `listenOptions` refuses them again;
   * this is the third refusal, at the point somebody would actually see it. A
   * single always-right button teaches nothing.
   */
  it("says the question is not ready rather than showing one option", () => {
    render(
      <ListenOptions
        options={[]}
        code="fr-FR"
        target={TARGET}
        focus="f"
        chosen={null}
        onChoose={vi.fn()}
      />,
    );

    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/isn’t ready yet/i);
    // And does not leak the answer while refusing.
    expect(screen.queryByText(TARGET)).toBeNull();
  });
});
