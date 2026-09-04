// @vitest-environment jsdom

/**
 * The front door, and the one gate in front of everything else.
 *
 * The name is asked once and then remembered, and it is not a nicety: it keys
 * the progress store and lands in every attempt and diagnostic record, which
 * is how eighty fixture recordings get grouped by speaker. So the two things
 * that matter here are that a session cannot start without one — an empty name
 * files a whole run under "anonymous" and merges it with everyone else on a
 * shared device — and that a learner can correct it without clearing storage
 * by hand, because the fixture runs several speakers through one browser.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { LanguagePicker } from "./LanguagePicker.js";
import { LANGUAGES } from "../activities/languages/index.js";

/**
 * jsdom here exposes localStorage as a bare object with no methods, so
 * useLearnerName's own try/catch would swallow every call and these tests
 * would pass without exercising the flow at all.
 */
function installStorage(seed?: Record<string, string>): Map<string, string> {
  const data = new Map(Object.entries(seed ?? {}));
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
      key: (i: number) => [...data.keys()][i] ?? null,
      get length() {
        return data.size;
      },
    },
  });
  return data;
}

function open() {
  return render(
    <MemoryRouter>
      <LanguagePicker />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  installStorage();
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (Macintosh)" });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("asking for a name", () => {
  it("asks before showing any language", () => {
    /**
     * The gate. Letting someone through unnamed files a whole run under
     * "anonymous" and, on the shared device a fixture session runs on, merges
     * it with every other speaker's — which is the one error the analysis
     * cannot detect afterwards.
     */
    open();

    expect(screen.getByText("What should we call you?")).toBeInTheDocument();
    expect(screen.queryByText("Which language?")).not.toBeInTheDocument();
  });

  it("says why it is asking, rather than just demanding it", () => {
    // "So your results are yours, not just a session number" is the whole
    // justification for asking a learner to identify themselves at all.
    open();

    expect(screen.getByText(/not just a session number/)).toBeInTheDocument();
  });

  it("refuses to continue on an empty name", () => {
    open();

    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("refuses a name that is only whitespace", () => {
    // Trimmed, not merely truthy: "   " passes a length check and is the same
    // as no name at all once it reaches the storage key.
    open();

    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "   " } });

    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("trims what it stores", () => {
    // A trailing space would make "Marie " and "Marie" two different learners
    // with two different progress stores.
    const data = installStorage();
    open();

    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "  Marie  " } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(data.get("sonare.learnerName")).toBe("Marie");
  });

  it("moves on to the languages once named", () => {
    open();

    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Marie" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText("Which language?")).toBeInTheDocument();
  });

  it("submits on Enter, since this is a one-field form on a phone", () => {
    // A learner on a phone keyboard reaches Enter before they reach a button.
    open();
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Marie" } });

    fireEvent.submit(screen.getByLabelText("Your name").closest("form")!);

    expect(screen.getByText("Which language?")).toBeInTheDocument();
  });

  it("does not submit an empty form on Enter", () => {
    open();

    fireEvent.submit(screen.getByLabelText("Your name").closest("form")!);

    expect(screen.getByText("What should we call you?")).toBeInTheDocument();
  });

  it("caps the length, so a paste cannot become a storage key", () => {
    open();

    expect(screen.getByLabelText("Your name")).toHaveAttribute("maxlength", "60");
  });

  it("turns autocomplete off", () => {
    /**
     * The browser's saved-name suggestions are the device owner's, and this
     * field is filled by whoever is speaking — which on a fixture device is
     * eight different people. Autofilling the owner's name would silently
     * mislabel a speaker.
     */
    open();

    expect(screen.getByLabelText("Your name")).toHaveAttribute("autocomplete", "off");
  });
});

describe("coming back", () => {
  it("skips straight to the languages for a remembered learner", () => {
    installStorage({ "sonare.learnerName": "Marie" });

    open();

    expect(screen.getByText("Which language?")).toBeInTheDocument();
    expect(screen.queryByLabelText("Your name")).not.toBeInTheDocument();
  });

  it("greets them by name, so a wrong one is visible immediately", () => {
    // On a shared device this line is the only thing that shows a session is
    // about to be filed under the previous speaker.
    installStorage({ "sonare.learnerName": "Marie" });

    open();

    expect(screen.getByText(/Hi, Marie\./)).toBeInTheDocument();
  });

  it("lets the next speaker correct it without clearing storage by hand", () => {
    /**
     * The fixture runs several speakers through one browser. Without this,
     * changing speaker means opening devtools — so in practice it would not
     * happen, and every recording after the first would carry the wrong name.
     */
    installStorage({ "sonare.learnerName": "speaker-a" });
    open();

    fireEvent.click(screen.getByRole("button", { name: "Not you?" }));

    expect(screen.getByText("What should we call you?")).toBeInTheDocument();
  });

  it("prefills the current name for a correction rather than an empty box", () => {
    // Usually a typo fix, not a different person.
    installStorage({ "sonare.learnerName": "Mareee" });
    open();

    fireEvent.click(screen.getByRole("button", { name: "Not you?" }));

    expect(screen.getByLabelText("Your name")).toHaveValue("Mareee");
  });

  it("returns to the languages after a correction", () => {
    installStorage({ "sonare.learnerName": "speaker-a" });
    open();
    fireEvent.click(screen.getByRole("button", { name: "Not you?" }));

    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "speaker-b" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText("Which language?")).toBeInTheDocument();
    expect(screen.getByText(/Hi, speaker-b\./)).toBeInTheDocument();
  });
});

describe("the language grid", () => {
  beforeEach(() => {
    installStorage({ "sonare.learnerName": "Marie" });
  });

  it("offers every shipped language", () => {
    open();

    for (const language of LANGUAGES) {
      expect(screen.getByRole("link", { name: new RegExp(language.label) })).toBeInTheDocument();
    }
  });

  it("links each to its own activity route", () => {
    open();

    for (const language of LANGUAGES) {
      expect(screen.getByRole("link", { name: new RegExp(language.label) })).toHaveAttribute(
        "href",
        `/${language.slug}`,
      );
    }
  });

  it("states how many activities each holds, so the commitment is known upfront", () => {
    // Ten takes with three tries each is a real amount of speaking. A learner
    // deciding whether to start deserves to know the size of it.
    open();

    for (const language of LANGUAGES) {
      // Queried through the card rather than by accessible name: the label and
      // the count are adjacent spans, so the computed name concatenates them
      // without a separator ("French10 activities").
      const card = screen.getByRole("link", { name: new RegExp(language.label) });
      expect(card.textContent, language.label).toContain(`${language.activities.length} activities`);
    }
  });

  it("shows the transparency panel before anything is recorded", () => {
    /**
     * Deliberately on the front door rather than behind the diagnostics
     * screen: it is what lets someone confirm what is captured *before*
     * granting a microphone, which is the only moment that confirmation is
     * worth anything.
     */
    open();

    expect(screen.getByText("What Sonare can see about this device")).toBeInTheDocument();
  });

  it("does not show the panel on the naming step", () => {
    // Device detail beside "what should we call you?" reads as surveillance
    // rather than as transparency.
    installStorage();

    open();

    expect(screen.queryByText("What Sonare can see about this device")).not.toBeInTheDocument();
  });
});
