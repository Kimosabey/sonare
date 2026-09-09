// @vitest-environment jsdom

/**
 * Structural accessibility, across the whole app and every state a learner
 * passes through.
 *
 * ── THIS IS NOT AN AXE SUBSTITUTE, AND MUST NOT BE DESCRIBED AS ONE ─────────
 *
 * Everything below is asserted from the DOM tree jsdom builds. jsdom has no
 * layout engine, no style resolution beyond inline declarations, no rendering,
 * no real focus ring and no accessibility-API bridge. So this file is blind to
 * every one of the following, and a green run says **nothing** about any of
 * them:
 *
 *   · **Colour contrast.** No computed colour, no computed background, no
 *     inheritance from a stylesheet — `getComputedStyle` here returns the
 *     initial values for almost everything. WCAG 1.4.3 and 1.4.11 are
 *     completely outside this file.
 *   · **Whether a focused control is visibly focused.** `:focus-visible` is
 *     not evaluated, outlines are not painted, and a rule that removed every
 *     focus ring in the product would not disturb one assertion here (WCAG
 *     2.4.7).
 *   · **Real tab order.** jsdom does not implement sequential focus
 *     navigation, so pressing Tab moves nothing. What is checked below is the
 *     *attributes* that determine order — never the traversal itself.
 *   · **Target size.** No geometry. The 44px tap floor is checked by
 *     `scripts/verify.mjs` reading the stylesheet, not here (NFR-03).
 *   · **Anything reflow, zoom, orientation or motion related.** No viewport,
 *     no media-query evaluation beyond the stub the report's count-up reads.
 *   · **What a screen reader actually says.** The accessible-name computation
 *     in this file is a deliberately conservative subset of the accname
 *     algorithm — `aria-labelledby`, `aria-label`, native labels, `alt`, and
 *     text content with `aria-hidden` subtrees removed, for the roles that are
 *     named from content. It does not implement name-from-`title`,
 *     name-from-placeholder, the `role=presentation` cascade, or any of the
 *     traversal rules that make the real algorithm hard. It will occasionally
 *     disagree with a browser.
 *   · **Whether a name is any *good*.** The sweep below asks only whether a
 *     name exists. A button labelled `×` has one, and deleting the toast's
 *     `aria-label="Dismiss notification"` leaves it announced as "times" —
 *     which the sweep cannot object to, because "is this name meaningful" is a
 *     judgement and not a structure. Only the named assertions further down
 *     cover that, and only for the controls they name.
 *   · **The page's own language** (WCAG 3.1.1). `<html lang="en">` lives in
 *     `index.html`, which no component render touches, so it is out of this
 *     file's reach entirely. Everything below is 3.1.2, Language of Parts.
 *
 * A real audit still needs axe (or equivalent) in a real browser, plus a pass
 * with an actual screen reader. Nothing here retires that question, and
 * treating it as though it does would be worse than having no suite at all —
 * an over-claimed accessibility check is how a product stops looking.
 *
 * ── What it *does* cover, and why these five ────────────────────────────────
 *
 * Five properties that are genuinely structural, that jsdom can see exactly,
 * and that each broke or nearly broke at least once in this codebase's own
 * comments:
 *
 *   1. **Every interactive element has an accessible name.** An unnamed
 *      control is announced as "button" and is unusable without sight of it.
 *   2. **The `aria-live` region stays mounted, empty or not.** A screen reader
 *      only announces changes inside a container that was already in the
 *      document, so mounting the container together with its content is the
 *      classic way to make an announcement silently never fire —
 *      `ActivityTest.tsx` says so in a comment, and a comment is not a test.
 *   3. **`lang` is on the target-language text and nowhere else.** Without it
 *      a reader says a French phrase in an English voice, in a product whose
 *      entire subject is how a phrase should sound (WCAG 3.1.2). Tagging the
 *      English instruction *around* it is the same fault pointed the other
 *      way.
 *   4. **Focus goes where the code says it goes.** Advancing an activity
 *      unmounts the button that was pressed, dropping focus to `<body>`; an
 *      error announces itself but leaves focus on a record button that is now
 *      disabled. Both have deliberate fixes, both are one refactor from
 *      silently reverting.
 *   5. **Nothing is reachable by pointer alone.** Every control is a real
 *      control or carries the role and tab stop of one.
 */

import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LANGUAGES } from "../activities/languages/index.js";
import {
  LEARNER_NAME_KEY,
  fill,
  follow,
  indeterminate,
  installBrowserGlobals,
  installFetch,
  installStorage,
  makeRecorderStub,
  onScreen,
  press,
  recordButton,
  renderApp,
  scored,
  speak,
  visit,
} from "./harness.js";

const { useRecorder, driver } = makeRecorderStub();
vi.mock("../speech/react/useRecorder.js", () => ({ useRecorder }));
vi.mock("../hooks/useCaptureToasts.js", () => ({
  useCaptureToasts: () => undefined,
  HEARD_SPEECH_SNR_DB: 10,
}));
/**
 * Playback and the model voice are both *available* here, unlike in the
 * journey suites.
 *
 * That is the point rather than a convenience: availability is what turns the
 * syllable chips from static spans into buttons and what makes the
 * "Hear yours, then mine" control exist at all. A suite that left both off
 * would never see the two richest sets of controls in the product.
 */
vi.mock("../hooks/useSyllablePlayback.js", () => ({
  useSyllablePlayback: () => ({ playingOffsetTicks: null, play: vi.fn(), available: true }),
}));
vi.mock("../hooks/useModelSpeech.js", async () => {
  const actual = await vi.importActual<typeof import("../hooks/useModelSpeech.js")>(
    "../hooks/useModelSpeech.js",
  );
  return {
    phraseTokens: actual.phraseTokens,
    useModelSpeech: () => ({
      speak: vi.fn(),
      cancel: vi.fn(),
      speaking: false,
      available: true,
      wordIndex: null,
    }),
  };
});
vi.mock("../hooks/useWakeLock.js", () => ({ useWakeLock: () => undefined }));

const FRENCH = (() => {
  const set = LANGUAGES.find((l) => l.slug === "fr");
  if (!set) throw new Error("French is no longer a shipped language");
  return set;
})();

/** Devanagari, because a `lang` bug is invisible in Latin script. */
const HINDI = (() => {
  const set = LANGUAGES.find((l) => l.slug === "hi");
  if (!set) throw new Error("Hindi is no longer a shipped language");
  return set;
})();

/* ── the conservative accname subset ──────────────────────────────────────── */

/**
 * Everything that takes a pointer or a keypress.
 *
 * Native elements first, then the ARIA roles that claim to be controls. A
 * `<summary>` is included: it is focusable and activatable, and three screens
 * put real content behind one.
 *
 * There is deliberately no `[onclick]` in this list. React attaches one
 * listener at the root and dispatches synthetically, so a `<div onClick>` — the
 * exact thing "reachable by pointer alone" is about — leaves *no* attribute on
 * the DOM node and cannot be found by querying for one. Including the selector
 * would look like a check and never match anything. What can be seen instead
 * is the shape such an element has: a non-native tag with no control role and
 * no tab stop, which is what the tests at the foot of this file assert against
 * the elements that are meant to be controls.
 */
const INTERACTIVE = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
  '[role="button"]',
  '[role="link"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="tab"]',
  '[role="menuitem"]',
].join(",");

function interactiveElements(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(INTERACTIVE)];
}

/**
 * Text as a reader would take it: the subtree with `aria-hidden` parts cut
 * out, and `.sr-only` text kept — that is text *for* a reader, not hidden
 * from one.
 */
function readableText(element: Element): string {
  const clone = element.cloneNode(true) as HTMLElement;
  for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Roles whose name may come from their own text content.
 *
 * Taken from accname's "name from content" list, and the distinction is
 * load-bearing rather than pedantry. A `<select>`'s text content is the text
 * of its options, so a text-content fallback applied to it reports
 * "FrenchSpanishGermanHindi" as the name of an unlabelled language switcher —
 * which is exactly how the first version of this file passed with the
 * switcher's `aria-label` deleted. A textbox, combobox, listbox, searchbox,
 * spinbutton and slider are all named by a label or by nothing.
 */
function namedFromContent(element: HTMLElement): boolean {
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
  ) {
    // The exception: a push-button input carries its name in `value`.
    return element instanceof HTMLInputElement && /^(submit|button|reset)$/.test(element.type);
  }
  const role = element.getAttribute("role");
  if (role !== null) {
    return !["textbox", "combobox", "listbox", "searchbox", "spinbutton", "slider"].includes(role);
  }
  return true;
}

/**
 * An accessible name, computed from the sources that actually appear in this
 * codebase. See the header: this is a subset, on purpose, and it is documented
 * as one rather than presented as accname.
 */
function accessibleName(element: HTMLElement): string {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy !== null) {
    const named = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter((node): node is HTMLElement => node !== null)
      .map(readableText)
      .join(" ")
      .trim();
    if (named.length > 0) return named;
  }

  const label = element.getAttribute("aria-label");
  if (label !== null && label.trim().length > 0) return label.trim();

  if (element instanceof HTMLImageElement) return element.alt.trim();

  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLButtonElement
  ) {
    const labels = [...(element.labels ?? [])].map(readableText).join(" ").trim();
    if (labels.length > 0) return labels;
  }

  // A push-button input's name is its value, which is not a text node.
  if (element instanceof HTMLInputElement && /^(submit|button|reset)$/.test(element.type)) {
    return element.value.trim();
  }

  return namedFromContent(element) ? readableText(element) : "";
}

/**
 * Fails naming every unnamed control, rather than the first.
 *
 * One assertion per screen with the whole list in the message: fixing these
 * one failure at a time is how a suite like this gets switched off.
 */
function expectEverythingNamed(where: string): void {
  const unnamed = interactiveElements()
    .filter((element) => accessibleName(element).length === 0)
    .map((element) => `<${element.tagName.toLowerCase()} class="${element.className}">`);
  expect(unnamed, `unnamed controls on ${where}`).toEqual([]);
  // A screen with no controls at all would pass the above vacuously.
  expect(interactiveElements().length, `no controls found on ${where}`).toBeGreaterThan(0);
}

/** Every `<details>` opened, so what is behind one is inspected too. */
function revealEverything(): void {
  for (const details of document.querySelectorAll("details")) details.setAttribute("open", "");
}

function liveRegion(): HTMLElement | null {
  // The activity screen's own region, not the toast rail — matched by being
  // the one inside the routed screen.
  return document.querySelector<HTMLElement>('.screen div[aria-live="polite"]');
}

function nextButton(): HTMLElement | null {
  return screen.queryByRole("button", { name: /Next activity|Finish and see report/i });
}

/** A take with two words, so the word chips and their detail panel both exist. */
function twoWordTake(accuracy: number) {
  return scored(accuracy, [
    { word: "bonjour", syllables: [["bon", 70], ["jour", 41]] },
    { word: "comment", syllables: [["com", 66], ["ment", 52]] },
  ]);
}

beforeEach(() => {
  installStorage({ [LEARNER_NAME_KEY]: "Marie" });
  installBrowserGlobals();
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("every control has a name a reader can announce", () => {
  it("on the front door, first visit and returning", async () => {
    installStorage();
    await renderApp("#/");
    revealEverything();
    expectEverythingNamed("Today, first visit");

    cleanup();
    vi.resetModules();
    installStorage({ [LEARNER_NAME_KEY]: "Marie" });
    await renderApp(`#/${FRENCH.slug}`);
    press(/^Start$/);
    speak(driver, twoWordTake(88));
    follow("Sonare");
    await onScreen("Today");
    revealEverything();
    expectEverythingNamed("Today, returning");
  });

  it("on the picker, both the name form and the language grid", async () => {
    installStorage();
    await renderApp("#/languages");
    revealEverything();
    expectEverythingNamed("the name form");

    fill("Your name", "Marie");
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
    press("Continue");
    await waitFor(() => expect(screen.getByText(/Hi, Marie\./)).toBeInTheDocument());
    revealEverything();
    expectEverythingNamed("the language grid");
  });

  it("on the activity screen, in all four of its states", async () => {
    await renderApp(`#/${FRENCH.slug}`);
    revealEverything();
    expectEverythingNamed("the activity intro, microphone settings open");

    press(/^Start$/);
    revealEverything();
    expectEverythingNamed("the prompt");

    fireEvent.click(recordButton());
    driver.enter("recording");
    expectEverythingNamed("while the microphone is open");

    driver.enter("processing");
    driver.score(twoWordTake(41));
    revealEverything();
    expectEverythingNamed("the result");

    // And behind a word chip, which is where the syllable buttons live.
    fireEvent.click(screen.getByRole("button", { name: /bonjour/ }));
    await waitFor(() => expect(document.querySelector(".phonemes")).not.toBeNull());
    expectEverythingNamed("an opened word chip");
  });

  it("on the error state", async () => {
    await renderApp(`#/${FRENCH.slug}`);
    press(/^Start$/);
    driver.enter("error", {
      code: "MIC_BLOCKED",
      domain: "client",
      userMessage: "Your microphone is blocked.",
      detail: "NotAllowedError",
    });

    expectEverythingNamed("the error state");
  });

  it("on the report at the end of a session", async () => {
    await renderApp(`#/${FRENCH.slug}`);
    press(/^Start$/);
    for (let i = 0; i < FRENCH.activities.length; i += 1) {
      speak(driver, twoWordTake(88));
      await waitFor(() => expect(nextButton()).not.toBeNull());
      press(/Next activity|Finish and see report/);
    }
    await waitFor(() => expect(screen.getByText("Today’s practice")).toBeInTheDocument());

    revealEverything();
    expectEverythingNamed("the report");
  });

  it("on Progress and on Settings", async () => {
    await renderApp(`#/${FRENCH.slug}`);
    press(/^Start$/);
    speak(driver, twoWordTake(88));

    await visit(`#/${FRENCH.slug}/progress`);
    await onScreen(`${FRENCH.label} progress`);
    revealEverything();
    expectEverythingNamed("Progress");

    follow("Your data");
    await onScreen("Settings");
    revealEverything();
    expectEverythingNamed("Settings");
  });

  it("on a toast, including the way to dismiss it", async () => {
    // Advancing pushes one, so this is the app's own toast rather than a
    // fabricated one.
    await renderApp(`#/${FRENCH.slug}`);
    press(/^Start$/);
    speak(driver, twoWordTake(88));
    await waitFor(() => expect(nextButton()).not.toBeNull());
    press(/Next activity/);

    const toast = await waitFor(() => {
      const node = document.querySelector<HTMLElement>(".toast");
      if (node === null) throw new Error("no toast");
      return node;
    });
    expect(within(toast).getByRole("button", { name: "Dismiss notification" })).toBeInTheDocument();
    expectEverythingNamed("a toast");
  });
});

describe("the live region is in the document before it has anything to say", () => {
  it("is mounted in the prompt state, with nothing in it", async () => {
    /**
     * The property, stated as the screen's own comment states it: a screen
     * reader only announces changes inside an `aria-live` container that was
     * already there. Mounting the container together with its content is the
     * classic way to make an announcement silently never fire.
     */
    await renderApp(`#/${FRENCH.slug}`);
    press(/^Start$/);

    const region = liveRegion();
    expect(region).not.toBeNull();
    expect(readableText(region as HTMLElement)).toBe("");
  });

  it("is the same node once a score arrives, not a fresh one", async () => {
    /**
     * Node identity is the whole assertion. A region that unmounts and
     * remounts with its content satisfies "an aria-live region exists next to
     * the score" and announces nothing at all, which is exactly the bug the
     * unconditional container prevents.
     */
    await renderApp(`#/${FRENCH.slug}`);
    press(/^Start$/);
    const before = liveRegion();
    expect(before).not.toBeNull();

    speak(driver, twoWordTake(41));

    const after = liveRegion();
    expect(after).toBe(before);
    expect(readableText(after as HTMLElement).length).toBeGreaterThan(0);
  });

  it("survives the microphone opening and closing", async () => {
    await renderApp(`#/${FRENCH.slug}`);
    press(/^Start$/);
    const before = liveRegion();

    fireEvent.click(recordButton());
    driver.enter("recording");
    expect(liveRegion()).toBe(before);
    driver.enter("processing");
    expect(liveRegion()).toBe(before);
    driver.score(twoWordTake(41));
    expect(liveRegion()).toBe(before);
  });

  it("and the toast rail is mounted before any toast exists", async () => {
    await renderApp("#/");

    const rail = document.querySelector('.toasts[aria-live="polite"]');
    expect(rail).not.toBeNull();
    expect(rail?.children).toHaveLength(0);
  });
});

describe("lang marks the language being taught, and only that", () => {
  it("tags the phrase and leaves the English around it alone", async () => {
    /**
     * Both halves matter. Without `lang` a reader says the French phrase with
     * English phonetics; with `lang` on the instruction above it, the reader
     * says English in a French voice. The activity screen's own comment names
     * this trade, so both directions are asserted.
     */
    await renderApp(`#/${FRENCH.slug}`);
    press(/^Start$/);
    const activity = FRENCH.activities[0];
    if (!activity) throw new Error("French has no first activity");

    const phrase = screen.getByText(activity.target);
    expect(phrase).toHaveAttribute("lang", FRENCH.code);

    for (const english of [activity.prompt, `“${activity.gloss}”`]) {
      const node = screen.getByText(english);
      expect(node.closest("[lang]")).toBeNull();
    }
  });

  it("tags a Devanagari phrase too, where a missing tag is silence rather than an accent", async () => {
    /**
     * Hindi is the case that makes this a correctness bug rather than a
     * polish one: an English voice given Devanagari does not mispronounce it,
     * it says nothing.
     */
    await renderApp(`#/${HINDI.slug}`);
    press(/^Start$/);
    const activity = HINDI.activities[0];
    if (!activity) throw new Error("Hindi has no first activity");

    expect(screen.getByText(activity.target)).toHaveAttribute("lang", HINDI.code);
  });

  it("tags the syllable and the word inside the score card", async () => {
    await renderApp(`#/${FRENCH.slug}`);
    press(/^Start$/);
    speak(driver, twoWordTake(41));

    const chip = screen.getByRole("button", { name: /bonjour/ });
    expect(within(chip).getByText("bonjour")).toHaveAttribute("lang", FRENCH.code);

    fireEvent.click(chip);
    await waitFor(() => expect(document.querySelector(".phonemes")).not.toBeNull());
    const detail = document.querySelector<HTMLElement>(".phonemes");
    if (detail === null) throw new Error("the detail panel did not open");
    // Twice per named syllable: once on the visible grapheme, so the browser
    // picks the right font and shaping, and once inside the screen-reader-only
    // sentence, so the number after it is still read in English.
    for (const grapheme of ["bon", "jour"]) {
      const tagged = [...detail.querySelectorAll(`[lang="${FRENCH.code}"]`)].map(
        (node) => node.textContent,
      );
      expect(tagged).toContain(grapheme);
    }
  });

  it("tags the resume card and the weakest sound on the front door", async () => {
    await renderApp(`#/${FRENCH.slug}`);
    press(/^Start$/);
    speak(driver, twoWordTake(41));
    speak(driver, twoWordTake(45));

    follow("Sonare");
    await onScreen("Today");

    const resume = screen.getByRole("link", { name: /Carry on/ });
    const activity = FRENCH.activities[0];
    if (!activity) throw new Error("French has no first activity");
    expect(within(resume).getByText(activity.title)).toHaveAttribute("lang", FRENCH.code);

    const working = screen.getByText(/Working on/);
    expect(within(working).getByText("jour")).toHaveAttribute("lang", FRENCH.code);
  });

  it("never puts a language tag on the English instruction anywhere on the screen", async () => {
    /**
     * The blanket version of the rule, which is what stops a well-meaning
     * `lang` on a wrapper. Every tagged node on the activity screen has to be
     * text genuinely in the language being taught, so each one is checked
     * against the activity's own target and syllables rather than against a
     * list maintained here.
     */
    await renderApp(`#/${FRENCH.slug}`);
    press(/^Start$/);
    const activity = FRENCH.activities[0];
    if (!activity) throw new Error("French has no first activity");

    const tagged = [...document.querySelectorAll(`[lang]`)].map((node) =>
      (node.textContent ?? "").trim(),
    );
    expect(tagged.length).toBeGreaterThan(0);
    for (const text of tagged) {
      expect(activity.target).toContain(text);
    }
  });
});

describe("focus goes where the code says it goes", () => {
  it("moves to the new activity when the learner advances", async () => {
    /**
     * The button that was pressed unmounts as part of the advance, which drops
     * focus to `<body>`. A keyboard or switch user is then at the top of the
     * document and has to traverse the whole page again to reach the new
     * prompt, on every one of ten activities; a screen reader user is simply
     * told nothing changed.
     */
    await renderApp(`#/${FRENCH.slug}`);
    press(/^Start$/);
    speak(driver, twoWordTake(88));
    await waitFor(() => expect(nextButton()).not.toBeNull());

    press(/Next activity/);

    const second = FRENCH.activities[1];
    if (!second) throw new Error("French has no second activity");
    await waitFor(() => expect(document.activeElement?.textContent).toBe(second.title));
    expect(document.activeElement?.tagName).toBe("H2");
  });

  it("leaves the focused heading out of the tab order", async () => {
    // Programmatically focusable, never a stop of its own — otherwise every
    // keyboard user gains a tab stop on a heading in exchange for the fix.
    await renderApp(`#/${FRENCH.slug}`);
    press(/^Start$/);
    speak(driver, twoWordTake(88));
    await waitFor(() => expect(nextButton()).not.toBeNull());
    press(/Next activity/);

    await waitFor(() => expect(document.activeElement?.tagName).toBe("H2"));
    expect(document.activeElement).toHaveAttribute("tabindex", "-1");
  });

  it("does not steal focus when the session opens", async () => {
    /**
     * The learner has just pressed Start and expects to be at the record
     * button. `advancedOnce` exists for this, and without it the same effect
     * that fixes advancing breaks starting.
     */
    await renderApp(`#/${FRENCH.slug}`);
    press(/^Start$/);

    await waitFor(() => expect(screen.getByText(/tries left/)).toBeInTheDocument());
    expect(document.activeElement?.tagName).not.toBe("H2");
  });

  it("moves to an error when one appears, because a live region alone leaves focus behind", async () => {
    /**
     * `aria-live` reads the error out but leaves focus wherever it was, which
     * for a capture failure is usually a record button that is now disabled.
     */
    await renderApp(`#/${FRENCH.slug}`);
    press(/^Start$/);
    fireEvent.click(recordButton());

    driver.enter("error", {
      code: "MIC_BLOCKED",
      domain: "client",
      userMessage: "Your microphone is blocked.",
      detail: "NotAllowedError",
    });

    await waitFor(() =>
      expect(document.activeElement?.textContent).toContain("Your microphone is blocked."),
    );
    // Announced as well as focused, and not a tab stop.
    expect(document.activeElement).toHaveAttribute("aria-live", "polite");
    expect(document.activeElement).toHaveAttribute("tabindex", "-1");
  });

  it("does not move focus again while the same error is still on screen", async () => {
    /**
     * `lastErrorCode` is what makes this hold, and it only earns its keep on a
     * *republished* error rather than a repeated one: the second `enter` below
     * passes a fresh object with the same code, which is what the real hook
     * does on a retry that fails the same way. Passing the identical object
     * would have React bail out of the render entirely and the effect would
     * never run — a version of this test that did that passed with the
     * `code !== lastErrorCode.current` guard deleted.
     */
    await renderApp(`#/${FRENCH.slug}`);
    press(/^Start$/);
    const error = () => ({
      code: "MIC_BLOCKED",
      domain: "client",
      userMessage: "Your microphone is blocked.",
      detail: "NotAllowedError",
    });
    driver.enter("error", error());
    await waitFor(() =>
      expect(document.activeElement?.textContent).toContain("Your microphone is blocked."),
    );

    const elsewhere = recordButton();
    elsewhere.focus();
    driver.enter("error", error());

    expect(document.activeElement).toBe(elsewhere);
  });

  it("does move focus again when a different failure replaces the first", async () => {
    // The other side of the same guard: a new problem is a new thing to read,
    // so it is announced and reachable rather than silently swapped in.
    await renderApp(`#/${FRENCH.slug}`);
    press(/^Start$/);
    driver.enter("error", {
      code: "MIC_BLOCKED",
      domain: "client",
      userMessage: "Your microphone is blocked.",
      detail: "NotAllowedError",
    });
    await waitFor(() =>
      expect(document.activeElement?.textContent).toContain("Your microphone is blocked."),
    );
    recordButton().focus();

    driver.enter("error", {
      code: "UPLOAD_TIMEOUT",
      domain: "network",
      userMessage: "That took too long to score.",
      detail: "AbortError",
    });

    await waitFor(() =>
      expect(document.activeElement?.textContent).toContain("That took too long to score."),
    );
  });
});

describe("nothing is reachable by pointer alone", () => {
  /**
   * What this can and cannot say, precisely.
   *
   * jsdom does not implement sequential focus navigation, so pressing Tab
   * moves nothing and traversal cannot be tested. What *is* exactly visible is
   * the set of attributes that decides traversal: whether a control is a
   * natively focusable element, and whether anything has been taken out of the
   * order with a negative `tabindex`. Both of the deliberate `tabIndex={-1}`
   * elements in the product are a heading and a status region — neither is a
   * control — so a negative tabindex on anything in the interactive set is a
   * control a keyboard cannot reach.
   */
  const NATIVE = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"]);

  function pointerOnly(): string[] {
    return interactiveElements()
      .filter((element) => {
        const tabindex = element.getAttribute("tabindex");
        if (tabindex !== null && Number(tabindex) < 0) return true;
        // A div carrying a control role needs a tab stop of its own.
        return !NATIVE.has(element.tagName) && tabindex === null;
      })
      .map((element) => `<${element.tagName.toLowerCase()} class="${element.className}">`);
  }

  it("across every learner screen", async () => {
    await renderApp("#/");
    revealEverything();
    expect(pointerOnly(), "Today").toEqual([]);

    follow("Your data");
    await onScreen("Settings");
    revealEverything();
    expect(pointerOnly(), "Settings").toEqual([]);
  });

  it("across the activity screen, including the score card's chips", async () => {
    await renderApp(`#/${FRENCH.slug}`);
    revealEverything();
    expect(pointerOnly(), "the intro").toEqual([]);

    press(/^Start$/);
    speak(driver, twoWordTake(41));
    revealEverything();
    fireEvent.click(screen.getByRole("button", { name: /bonjour/ }));
    await waitFor(() => expect(document.querySelector(".phonemes")).not.toBeNull());

    expect(pointerOnly(), "the result").toEqual([]);
  });

  it("makes the tappable cards real links rather than handlers on a div", async () => {
    /**
     * The front door's cards are the largest tap targets in the product. As
     * `<div onClick>` they would be invisible to a keyboard and to a screen
     * reader's link list, and would lose middle-click and open-in-new-tab
     * along the way.
     */
    installStorage();
    await renderApp("#/");
    for (const card of document.querySelectorAll(".lang-card")) {
      expect(card.tagName).toBe("A");
      expect(card).toHaveAttribute("href");
    }
  });

  it("keeps the syllable chips as buttons when they do something, and text when they do not", async () => {
    /**
     * The chips are the product's core interaction — tapping one replays that
     * slice of the learner's own audio — and they are only a control when
     * there is audio to replay. A span with a click handler would be the easy
     * way to write this and unreachable without a pointer; a button that does
     * nothing would be a promise the page cannot keep.
     */
    await renderApp(`#/${FRENCH.slug}`);
    press(/^Start$/);
    speak(driver, twoWordTake(41));
    fireEvent.click(screen.getByRole("button", { name: /bonjour/ }));
    await waitFor(() => expect(document.querySelector(".phonemes")).not.toBeNull());

    const chips = [...document.querySelectorAll<HTMLElement>(".phonemes .sy")];
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) {
      expect(chip.tagName).toBe("BUTTON");
      expect(accessibleName(chip)).toMatch(/scored \d+ out of 100/);
    }
  });

  it("gives the sensitivity group a heading without renaming its buttons", async () => {
    /**
     * A `<label for>` on the group heading associated it with exactly one
     * button and *renamed* it: the middle option was announced as "Pause
     * before it stops" and the word "Normal" was never spoken. The group takes
     * the heading through `aria-labelledby`; each button keeps its own name.
     */
    await renderApp(`#/${FRENCH.slug}`);
    revealEverything();

    const group = screen.getByRole("group", { name: "Pause before it stops" });
    for (const name of ["Quick", "Normal", "Patient"]) {
      expect(within(group).getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("gives each capture toggle a name and a state", async () => {
    await renderApp(`#/${FRENCH.slug}`);
    revealEverything();

    for (const name of ["Continuous listening", "Auto-stop", "Interim results"]) {
      const control = screen.getByRole("switch", { name: new RegExp(name) });
      expect(control).toHaveAttribute("aria-checked");
    }
  });
});

describe("what is decorative says so", () => {
  it("hides the progress rail's own bar and the breadcrumb separators", async () => {
    /**
     * Read aloud, a chevron between every crumb is noise on every screen, and
     * a percentage-width `<div>` is not information — the rail beside it
     * carries the same state with a name per step.
     */
    await renderApp(`#/${FRENCH.slug}`);
    press(/^Start$/);

    expect(document.querySelector(".steps-track")).toHaveAttribute("aria-hidden", "true");
    const rail = screen.getByRole("list", { name: /Activity \d+ of \d+/ });
    const steps = within(rail).getAllByRole("listitem");
    expect(steps).toHaveLength(FRENCH.activities.length);
    for (const step of steps) {
      expect(step.getAttribute("aria-label")).toMatch(
        /^Activity \d+: (current|passed|skipped|upcoming)$/,
      );
    }
  });

  it("gives every calendar square its own date rather than an unlabelled wall", async () => {
    await renderApp(`#/${FRENCH.slug}`);
    press(/^Start$/);
    speak(driver, indeterminate());

    await visit(`#/${FRENCH.slug}/progress`);
    await onScreen(`${FRENCH.label} progress`);

    const calendar = screen.getByRole("table", { name: /Practice over the last \d+ weeks/ });
    const cells = within(calendar).getAllByRole("cell");
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.getAttribute("aria-label")).toMatch(
        /^\d{4}-\d{2}-\d{2}: (practised|no practice)$/,
      );
    }
  });
});

/**
 * Both screens now tag the syllable with the language it belongs to.
 *
 * The same syllable was tagged on Today (`src/pages/Today.tsx`) and untagged
 * on the two other screens that render it — `Progress.tsx` and
 * `SessionSummary.tsx` — so a screen reader read "jour" in French on the
 * front door and in English on the screen built specifically for reviewing
 * sounds. For Hindi it is worse than mispronunciation: an untagged Devanagari
 * grapheme in an English voice is *skipped*, so the row is read as a number
 * with no sound named in it (WCAG 3.1.2).
 *
 * Progress is asserted below. **The session summary is asserted in
 * `src/components/SessionSummary.test.tsx` instead, because a journey cannot
 * reach it** — `trendFor` reports a `before` only once a syllable has more
 * than RECENT_WINDOW samples with two behind the window, seven in all, and a
 * stored sample's identity is its timestamp. Every take in a jsdom run lands
 * in the same millisecond, so twenty takes collapse into one sample,
 * `improved()` returns nothing, and the list never renders. That file seeds
 * the history directly, which is the only way to express the case.
 *
 * Worth recording what that cost: the test that used to live here threw from
 * its own setup and never reached its assertion — but under `it.fails` that
 * still counted as a pass. It claimed to pin a missing `lang` attribute and
 * was really pinning its own inability to get to the screen. **An `it.fails`
 * that fails for a setup reason is indistinguishable from one that fails for
 * the asserted reason.** Only fixing the defect tells you which you had.
 */
describe("the language tagging that was missing", () => {
  it("tags the syllables on Progress with the language they are in", async () => {
    await renderApp(`#/${FRENCH.slug}`);
    press(/^Start$/);
    speak(driver, twoWordTake(41));
    speak(driver, twoWordTake(45));

    await visit(`#/${FRENCH.slug}/progress`);
    await onScreen(`${FRENCH.label} progress`);

    const table = screen.getByRole("columnheader", { name: "Syllable" }).closest("table");
    if (table === null) throw new Error("the sounds table lost its own header");
    expect(within(table).getByText("jour")).toHaveAttribute("lang", FRENCH.code);
  });
});
