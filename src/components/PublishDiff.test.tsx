// @vitest-environment jsdom

/**
 * The screen an operator meets before an irreversible publish.
 *
 * The board is explicit that this is "not a gate", so none of these tests
 * assert that anything is refused. They assert the two things the board makes
 * the screen responsible for: that the friction lands on the removal rather
 * than on publishing, and that every number shown is one the server actually
 * knows.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublishDiff } from "./PublishDiff.js";
import { diffContent } from "../content/diff.js";
import type { Activity, LanguageActivitySet } from "../activities/types.js";

afterEach(cleanup);

function activity(id: number, over: Partial<Activity> = {}): Activity {
  return {
    id,
    title: `Activity ${id}`,
    kind: "repeat",
    prompt: `Say phrase ${id}`,
    gloss: `Phrase ${id}`,
    target: `Phrase ${id}`,
    focus: `focus ${id}`,
    soundTargets: [`syl${id}`],
    ...over,
  };
}

function set(activities: Activity[]): LanguageActivitySet {
  return {
    code: "fr-FR",
    slug: "fr",
    label: "French",
    activities,
    units: [
      {
        id: 2,
        title: "Ordering food",
        outcome: "You can order food and be understood.",
        lessons: [
          {
            id: 2,
            title: "Ordering a coffee",
            outcome: "You can ask for a coffee.",
            activityIds: activities.map((a) => a.id),
          },
        ],
      },
    ],
  };
}

function show(
  before: LanguageActivitySet,
  after: LanguageActivitySet,
  over: Partial<Parameters<typeof PublishDiff>[0]> = {},
) {
  const onPublish = over.onPublish ?? vi.fn();
  render(
    <PublishDiff
      label="French"
      code="fr-FR"
      fromVersion={7}
      toVersion={8}
      changes={diffContent(before, after)}
      reach={new Map()}
      onPublish={onPublish}
      onBack={vi.fn()}
      {...over}
    />,
  );
  return { onPublish };
}

describe("the friction is attached to the removal, not to publishing", () => {
  /**
   * The board's own reasoning: "Without a removal in the diff, publishing is
   * one click and no typing — the friction is attached to the irreversible
   * case, not to the act of publishing." A confirmation on every publish is a
   * confirmation nobody reads.
   */
  it("publishes a copy edit in one click, with nothing to type", () => {
    show(set([activity(1)]), set([activity(1, { gloss: "clearer" })]));

    expect(screen.queryByLabelText(/type/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish v8" })).toBeEnabled();
  });

  it("asks for the phrase when something is removed", () => {
    show(set([activity(1), activity(2)]), set([activity(1)]));

    expect(screen.getByRole("button", { name: "Publish v8" })).toBeDisabled();
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("enables publishing once the phrase matches", () => {
    show(set([activity(1), activity(2)]), set([activity(1)]));

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "PUBLISH V8" } });

    expect(screen.getByRole("button", { name: "Publish v8" })).toBeEnabled();
  });

  /**
   * The phrase carries the version number on purpose, so typing it is proof
   * the operator read *which* version they are publishing. A phrase that
   * unlocked on any version number would confirm nothing but the typing.
   */
  it("does not unlock on a different version's phrase", () => {
    show(set([activity(1), activity(2)]), set([activity(1)]));

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "PUBLISH V7" } });

    expect(screen.getByRole("button", { name: "Publish v8" })).toBeDisabled();
  });

  it("folds case and surrounding space, which are not what is being confirmed", () => {
    show(set([activity(1), activity(2)]), set([activity(1)]));

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  publish v8 " } });

    expect(screen.getByRole("button", { name: "Publish v8" })).toBeEnabled();
  });

  it("does not publish while the button is disabled", () => {
    const { onPublish } = show(set([activity(1), activity(2)]), set([activity(1)]));

    fireEvent.click(screen.getByRole("button", { name: "Publish v8" }));

    expect(onPublish).not.toHaveBeenCalled();
  });
});

describe("the counts it shows", () => {
  it("reports how many learners have practised a removed activity", () => {
    show(set([activity(1), activity(2)]), set([activity(1)]), {
      reach: new Map([[2, 41]]),
    });

    expect(screen.getByText(/41 learners have attempts/)).toBeInTheDocument();
  });

  it("says one learner rather than 1 learners", () => {
    show(set([activity(1), activity(2)]), set([activity(1)]), {
      reach: new Map([[2, 1]]),
    });

    expect(screen.getByText(/1 learner has attempts/)).toBeInTheDocument();
  });

  /**
   * The distinction that decides whether an operator can trust the panel. A
   * fetch that failed and a fetch that returned nobody are different facts,
   * and only one of them makes a removal safe.
   */
  it("says it could not check, rather than that nobody is affected", () => {
    show(set([activity(1), activity(2)]), set([activity(1)]), { reach: null });

    expect(screen.getByText(/could not check/i)).toBeInTheDocument();
    expect(screen.queryByText(/no learner has attempts/i)).not.toBeInTheDocument();
  });

  it("says nobody is affected only when it has been told so", () => {
    show(set([activity(1), activity(2)]), set([activity(1)]), { reach: new Map() });

    expect(screen.getByText(/no learner has attempts/i)).toBeInTheDocument();
  });

  /**
   * Per-activity counts cannot be added: one learner may have attempts against
   * several removed activities, so a total would double-count them. The screen
   * says so rather than quietly presenting a sum.
   */
  it("does not add per-activity counts into a learner total", () => {
    show(set([activity(1), activity(2), activity(3)]), set([activity(1)]), {
      reach: new Map([
        [2, 20],
        [3, 30],
      ]),
    });

    expect(screen.queryByText(/50/)).not.toBeInTheDocument();
    expect(screen.getByText(/counted per activity, not added up/i)).toBeInTheDocument();
  });

  /**
   * Three of the board's four figures need per-learner session and version
   * telemetry this system does not record. Inventing them is the fabrication
   * the product refuses everywhere else it reports a measurement, so the panel
   * names them as unrecorded instead.
   */
  it("names the figures it does not have rather than inventing them", () => {
    show(set([activity(1)]), set([activity(1, { gloss: "clearer" })]));

    expect(screen.getByText(/are not recorded, so they are not shown/i)).toBeInTheDocument();
  });
});

describe("the edit that re-keys a sound history", () => {
  it("says so when the target changes", () => {
    show(
      set([activity(1, { target: "le poisson" })]),
      set([activity(1, { target: "le poison" })]),
    );

    expect(screen.getByText(/re-keys the syllables/i)).toBeInTheDocument();
  });

  it("says the opposite when the target is untouched", () => {
    show(set([activity(1)]), set([activity(1, { gloss: "clearer" })]));

    expect(screen.getByText(/target text untouched/i)).toBeInTheDocument();
    expect(screen.queryByText(/re-keys the syllables/i)).not.toBeInTheDocument();
  });

  /**
   * A re-key is consequential but it is not a removal, and the board attaches
   * the typed phrase to removals. Nothing is taken out of a lesson, so the
   * publish stays one click — the warning does the work.
   */
  it("does not ask for a typed phrase", () => {
    show(
      set([activity(1, { target: "le poisson" })]),
      set([activity(1, { target: "le poison" })]),
    );

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish v8" })).toBeEnabled();
  });
});

describe("the language-bearing text", () => {
  /**
   * A design constraint the whole product is held to: every string in the
   * language being learnt carries `lang`, so a screen reader does not read
   * French with an English voice.
   */
  it("marks a removed activity's phrase as the content language", () => {
    show(set([activity(1), activity(2, { target: "le poisson" })]), set([activity(1)]));

    expect(screen.getByText("le poisson")).toHaveAttribute("lang", "fr-FR");
  });

  it("marks an added activity's phrase too", () => {
    show(set([activity(1)]), set([activity(1), activity(2, { target: "un croissant" })]));

    expect(screen.getByText("un croissant")).toHaveAttribute("lang", "fr-FR");
  });

  it("marks both sides of a changed target", () => {
    show(
      set([activity(1, { target: "le poisson" })]),
      set([activity(1, { target: "le poison" })]),
    );

    expect(screen.getByText("le poisson")).toHaveAttribute("lang", "fr-FR");
    expect(screen.getByText("le poison")).toHaveAttribute("lang", "fr-FR");
  });

  /**
   * A gloss is English. Marking it as the content language would be the same
   * mistake in the other direction.
   */
  /**
   * Both sides, because they are separate elements and a `lang` on either one
   * is the same mistake. The old value is as much English as the new one.
   */
  it("does not mark an English gloss as the content language", () => {
    show(
      set([activity(1, { gloss: "The fish" })]),
      set([activity(1, { gloss: "The poison" })]),
    );

    expect(screen.getByText("The fish")).not.toHaveAttribute("lang");
    expect(screen.getByText("The poison")).not.toHaveAttribute("lang");
  });
});

describe("the header", () => {
  it("names the version transition being published", () => {
    show(set([activity(1)]), set([activity(1, { gloss: "clearer" })]));

    expect(screen.getByText(/v7 → v8/)).toBeInTheDocument();
  });

  it("counts the changes, and says one change rather than 1 changes", () => {
    show(set([activity(1)]), set([activity(1, { gloss: "clearer" })]));
    expect(screen.getByText(/1 change(?!s)/)).toBeInTheDocument();

    cleanup();

    show(set([activity(1), activity(2)]), set([activity(1, { gloss: "clearer" })]));
    expect(screen.getByText(/2 changes/)).toBeInTheDocument();
  });
});

describe("an empty diff", () => {
  it("says there is nothing to publish rather than showing an empty list", () => {
    show(set([activity(1)]), set([activity(1)]));

    expect(screen.getByText(/nothing differs from v7/i)).toBeInTheDocument();
  });
});
