// @vitest-environment jsdom

/**
 * Suggesting a sitting.
 *
 * The board's constraint is that this "cannot strand anyone", and every test
 * here is a way that could quietly stop being true: a timing control with no
 * open option, a lesson set as homework when every activity needs a
 * microphone, or a teacher left to assume a mark is coming.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUGGESTION_WINDOWS, SetSitting } from "./SetSitting.js";
import type { Activity, Lesson } from "../activities/types.js";

afterEach(cleanup);

const LESSON: Lesson = {
  id: 2,
  title: "Ordering food · Lesson 2",
  outcome: "You can order a coffee.",
  activityIds: [1, 2, 3, 4],
};

function activity(id: number, over: Partial<Activity> = {}): Activity {
  return {
    id,
    title: `Activity ${id}`,
    kind: "repeat",
    prompt: "Say it",
    gloss: "a coffee",
    target: "Je voudrais un café",
    focus: "the French r",
    soundTargets: ["ʁ"],
    ...over,
  };
}

const FOUR: Activity[] = [
  activity(1),
  activity(2, { kind: "listen", target: "Je voudrais un café et un croissant", distractors: ["x"] }),
  activity(3, { kind: "respond", target: "Un café, s’il vous plaît", soundTargets: ["ui"] }),
  activity(4, { kind: "recall", gloss: "and a croissant", target: "et un croissant", soundTargets: ["an"] }),
];

function show(over: Partial<Parameters<typeof SetSitting>[0]> = {}) {
  const onSuggest = over.onSuggest ?? vi.fn();
  render(
    <SetSitting
      lesson={LESSON}
      activities={FOUR}
      code="fr-FR"
      joinedCount={28}
      onSuggest={onSuggest}
      {...over}
    />,
  );
  return { onSuggest };
}

describe("it cannot become a deadline", () => {
  /**
   * A timing control whose every value is a deadline *is* a deadline control.
   * "No particular time" sits with the other two rather than below them.
   */
  it("offers a window with no time in it at all", () => {
    show();

    expect(screen.getByRole("radio", { name: "No particular time" })).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(SUGGESTION_WINDOWS.length);
  });

  /**
   * Said in the words a teacher will judge it by. The board spells out all
   * three escapes — late, partly, or moving on after three tries — because a
   * teacher who thinks this is an assignment will treat a pupil who used one
   * of them as having failed it.
   */
  it("says what a pupil may do instead, in full", () => {
    show();

    expect(screen.getByText(/not a lock/i)).toBeInTheDocument();
    expect(screen.getByText(/do it late, do it partly/i)).toBeInTheDocument();
    expect(screen.getByText(/move on from an activity after three tries/i)).toBeInTheDocument();
  });

  /**
   * The expectation set before the suggestion goes out. A teacher who is not
   * told a mark is never coming will go looking for one.
   */
  it("says the feedback is the class's, not a pupil's", () => {
    show();

    expect(screen.getByText(/never a mark for how it went/i)).toBeInTheDocument();
    expect(screen.getByText(/the class’s, not a pupil’s/i)).toBeInTheDocument();
  });

  it("reports the chosen window", () => {
    const { onSuggest } = show();

    fireEvent.click(screen.getByRole("radio", { name: "No particular time" }));
    fireEvent.click(screen.getByRole("button", { name: /Suggest to 28 pupils/ }));

    expect(onSuggest).toHaveBeenCalledWith({ lessonId: 2, window: "no-particular-time" });
  });
});

describe("what makes it settable as homework", () => {
  /**
   * The microphone-free count is the fact a teacher needs to judge whether a
   * sitting can be set at all — for a bus, a shared room, or a pupil whose
   * device is why half their takes come back unusable.
   */
  it("names how many activities need no microphone", () => {
    show();

    expect(screen.getByText(/One activity needs no microphone/)).toBeInTheDocument();
  });

  it("says nothing when every activity needs one", () => {
    show({ activities: [activity(1), activity(2)] });

    expect(screen.queryByText(/no microphone/)).toBeNull();
  });

  it("counts them when there are several", () => {
    show({
      activities: [
        activity(1, { kind: "listen", distractors: ["x"] }),
        activity(2, { kind: "listen", distractors: ["y"] }),
      ],
    });

    expect(screen.getByText(/2 activities need no microphone/)).toBeInTheDocument();
  });
});

describe("the activity list", () => {
  it("states the shape before the detail", () => {
    show();

    expect(screen.getByText(/4 activities, about 5 minutes/)).toBeInTheDocument();
  });

  /**
   * A `listen` activity's target is the answer. Printing it would put the
   * answer on a screen a teacher might project, which is an odd way to lose a
   * question.
   */
  it("describes a listen activity rather than printing its answer", () => {
    show();

    const rows = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    const listen = rows.find((text) => text.startsWith("listen"));

    expect(listen).toContain("Pick the meaning");
    expect(listen).not.toContain("Je voudrais un café et un croissant");
  });

  it("shows a recall activity as the meaning, not the phrase", () => {
    show();

    const rows = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    const recall = rows.find((text) => text.startsWith("recall"));

    expect(recall).toContain("and a croissant");
    expect(recall).not.toContain("et un croissant");
  });

  it("marks a spoken phrase as the content language", () => {
    show();

    expect(screen.getByText("Je voudrais un café")).toHaveAttribute("lang", "fr-FR");
  });

  it("does not mark an English description as the content language", () => {
    show();

    expect(screen.getByText(/Pick the meaning/)).not.toHaveAttribute("lang");
  });

  it("names the sounds the sitting targets, deduplicated", () => {
    show();

    const summary = screen.getByText(/4 activities, about 5 minutes/).textContent ?? "";
    expect(summary).toContain("an and ui and ʁ");
  });
});

describe("the button", () => {
  it("says how many pupils it reaches", () => {
    show({ joinedCount: 1 });
    expect(screen.getByRole("button", { name: "Suggest to 1 pupil" })).toBeInTheDocument();
  });

  it("stops while a suggestion is in flight", () => {
    show({ busy: true });

    const button = screen.getByRole("button", { name: "Suggesting…" });
    expect(button).toBeDisabled();
  });
});

describe("a sitting with no sound targets", () => {
  it("says nothing about sounds rather than printing an empty list", () => {
    show({ activities: [activity(1, { soundTargets: [] })] });

    const summary = screen.getByText(/1 activity, about 1 minutes/).textContent ?? "";
    expect(summary).not.toContain("Targets");
  });

  it("still says what the feedback loop will show", () => {
    show({ activities: [activity(1, { soundTargets: [] })] });

    expect(screen.getByText(/these sounds afterwards/)).toBeInTheDocument();
  });
});
