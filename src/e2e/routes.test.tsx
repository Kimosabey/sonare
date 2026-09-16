// @vitest-environment jsdom

/**
 * Every route, mounted in the real app.
 *
 * The gap this fills is specific. Each screen has its own suite, and every one
 * of those renders the component **in isolation** — its own router, its own
 * stubs, no shell. So a screen can be thoroughly tested and still be unable to
 * render inside the actual application: a lazy chunk that never resolves, a
 * provider it needs and the shell does not supply, a route param the shell
 * parses differently from the test's `MemoryRouter`, a hook that behaves
 * differently under the real `HashRouter`.
 *
 * Five screens were added in one session — Journey, the microphone check,
 * onboarding, the You tab's additions and the navigation shell — and none was
 * mounted through `App` by any test. This mounts all of them, at the address a
 * learner would actually arrive on.
 *
 * It is deliberately shallow. It does not assert what each screen *says* —
 * that is each screen's own suite's job, and repeating it here would be a
 * second copy to keep in step. It asserts that the screen exists, renders a
 * heading, and throws nothing on the way.
 */

import { cleanup, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installBrowserGlobals,
  installFetch,
  installStorage,
  makeRecorderStub,
  renderApp,
} from "./harness.js";

const { useRecorder } = makeRecorderStub();
vi.mock("../speech/react/useRecorder.js", () => ({ useRecorder }));
vi.mock("../hooks/useCaptureToasts.js", () => ({
  useCaptureToasts: () => undefined,
  HEARD_SPEECH_SNR_DB: 10,
}));

/**
 * Anything React logs as an error is a failure here.
 *
 * A screen that renders "successfully" while React complains about a missing
 * key, an invalid nesting or an update outside `act` is a screen that is
 * broken in a way the DOM does not show. This is the one place in the suite
 * where the whole app is assembled, so it is the right place to insist.
 */
let errors: unknown[][] = [];
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  installStorage();
  installBrowserGlobals();
  installFetch();
  errors = [];
  consoleError = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args);
  });
});

afterEach(() => {
  consoleError.mockRestore();
  cleanup();
});

/**
 * Every address a learner can reach, with what it should show.
 *
 * Internal tooling is here too — `#/diagnostics`, `#/fixture`, `#/authoring`.
 * Nothing links to them, but they are reachable by typing, and a crash in one
 * is a crash a support conversation runs into at the worst moment.
 */
const ROUTES: [label: string, hash: string, heading: RegExp][] = [
  ["Today", "#/", /Welcome|Today/i],
  ["the language picker", "#/languages", /language/i],
  ["a session", "#/fr", /French/i],
  ["Journey", "#/fr/journey", /journey|French/i],
  ["Progress", "#/fr/progress", /progress/i],
  ["the You tab", "#/settings", /Settings/i],
  ["onboarding", "#/welcome", /Hear it first/i],
  ["the microphone check", "#/check", /Say anything|microphone/i],
  ["diagnostics", "#/diagnostics", /Diagnostics/i],
  ["the fixture runner", "#/fixture", /Fixture/i],
  ["authoring", "#/authoring", /Content/i],
];

describe("every route renders in the real app", () => {
  it.each(ROUTES)("%s", async (_label, hash, heading) => {
    await renderApp(hash);

    /**
     * Waits for the *expected* heading, not for any heading.
     *
     * The shell renders its own `<h1>` before the route's lazy chunk resolves,
     * so "some heading exists" is true in the first frame on every route — the
     * first version of this waited on exactly that and reported three screens
     * as broken when they had simply not loaded yet.
     */
    await waitFor(() => {
      const headings = screen.getAllByRole("heading").map((h) => h.textContent ?? "");
      expect(headings.join(" · "), `${hash} showed: ${headings.join(" · ")}`).toMatch(heading);
    });
  });

  it.each(ROUTES)("%s logs nothing to console.error", async (_label, hash) => {
    await renderApp(hash);
    // Long enough for a lazy chunk to resolve and for any effect it schedules
    // to run — an error logged after the first paint is still an error.
    await waitFor(() => {
      expect(screen.getAllByRole("heading").length).toBeGreaterThan(0);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errors.map((e) => String(e[0])).join("\n")).toBe("");
  });
});

describe("exactly one top-level heading, everywhere", () => {
  /**
   * A page with two `<h1>`s has two answers to "what is this screen", and a
   * screen-reader user navigating by heading meets the wrong one first.
   *
   * This found a real pair on three routes. Screens that shipped before the
   * course work take their heading from the shell; the ones added since name
   * themselves — so on `#/welcome`, `#/check` and `#/fr/journey` the shell
   * rendered "Today" above the screen's own title, because it did not
   * recognise the path.
   *
   * Asserted for every route rather than only those three, so a screen added
   * on either side of that line cannot reintroduce the pair silently.
   */
  it.each(ROUTES)("%s", async (_label, hash) => {
    await renderApp(hash);

    // The screen itself, not the shell's first frame — a lazy chunk that has
    // not resolved would make every route look like it has exactly one.
    await waitFor(() => {
      expect(document.querySelectorAll("section").length).toBeGreaterThan(0);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const h1s = screen.queryAllByRole("heading", { level: 1 }).map((h) => h.textContent ?? "");
    expect(h1s.length, `${hash} has: ${h1s.join(" | ")}`).toBe(1);
  });
});

describe("an address that is not a route", () => {
  /**
   * A typo, or a link from a version that had a screen this one does not.
   * It must land somewhere a learner can act from rather than on a blank page
   * — an installed PWA has no address bar to correct it in.
   */
  it("still renders something with a way onward", async () => {
    await renderApp("#/not-a-real-screen");

    await waitFor(() => {
      expect(screen.getAllByRole("heading").length).toBeGreaterThan(0);
    });
    expect(screen.getAllByRole("link").length).toBeGreaterThan(0);
  });
});
