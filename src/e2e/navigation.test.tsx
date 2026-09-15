// @vitest-environment jsdom

/**
 * Navigation across the app — board D7, and N9.
 *
 * Two rules, and both exist because of what an **installed PWA** is missing.
 *
 * **Every non-root screen offers a way back.** In standalone display mode
 * Safari's chrome is gone entirely: there is no browser back button, no
 * address bar and no tab strip. A screen with no in-app way out is a dead end
 * reachable only by force-quitting the app. The affordance this replaces was
 * an 11px breadcrumb link — under the tap floor, and invisible to NFR-03,
 * which flags CSS *declaring* a sub-44px min-height and cannot see a control
 * that declares none at all.
 *
 * **The tab bar is gone during a sitting.** A sitting is the one flow in the
 * product with a finish line, and a tab bar beside it is a standing invitation
 * to leave it half-done.
 */

import { cleanup, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installBrowserGlobals,
  installFetch,
  installStorage,
  makeRecorderStub,
  renderApp,
  visit,
} from "./harness.js";

const { useRecorder } = makeRecorderStub();
vi.mock("../speech/react/useRecorder.js", () => ({ useRecorder }));
vi.mock("../hooks/useCaptureToasts.js", () => ({
  useCaptureToasts: () => undefined,
  HEARD_SPEECH_SNR_DB: 10,
}));

beforeEach(() => {
  installStorage();
  installBrowserGlobals();
  installFetch();
});

afterEach(cleanup);

/** The four tab roots, which deliberately have no in-app back. */
const TAB_ROOTS = ["#/", "#/settings"];

/** Screens inside a tab, which must all offer one. */
const INSIDE_A_TAB = ["#/languages"];

describe("the tab bar", () => {
  it("offers the four destinations on a tab root", async () => {
    await renderApp("#/");

    const tabs = screen.getByRole("navigation", { name: "Main" });
    expect(within(tabs).getAllByRole("link")).toHaveLength(4);
  });

  /**
   * Gone, not dimmed. A disabled tab is worse than an absent one: it looks
   * like a way out and is not.
   */
  it("is gone entirely while a sitting is running", async () => {
    await renderApp("#/fr");

    expect(screen.queryByRole("navigation", { name: "Main" })).not.toBeInTheDocument();
  });

  it("comes back when the sitting is left", async () => {
    await renderApp("#/fr");
    expect(screen.queryByRole("navigation", { name: "Main" })).not.toBeInTheDocument();

    await visit("#/");

    expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
  });
});

describe("the way back", () => {
  /**
   * N9. Each of these is a screen a learner can reach, and in an installed PWA
   * there is nothing else on the display that leads anywhere.
   */
  it.each(INSIDE_A_TAB)("is offered on %s", async (path) => {
    await renderApp(path);

    const back = screen.getByRole("link", { name: /^Back to / });
    expect(back).toBeInTheDocument();
    expect(back.getAttribute("href")).toBeTruthy();
  });

  /**
   * It names where it goes. "Back" alone leaves a screen-reader user with no
   * idea what they are about to land on.
   */
  it("says what it is going back to", async () => {
    await renderApp("#/languages");

    expect(screen.getByRole("link", { name: /^Back to \w+/ })).toBeInTheDocument();
  });

  /**
   * Not on a tab root. The board is explicit, and on Android the system back
   * already closes the app from one — an in-app back there would be a second,
   * differently-behaved answer to the same gesture.
   */
  it.each(TAB_ROOTS)("is absent on the tab root %s", async (path) => {
    await renderApp(path);

    expect(screen.queryByRole("link", { name: /^Back to / })).not.toBeInTheDocument();
  });

  /**
   * An explicit destination rather than `history.back()`. A screen opened from
   * a typed URL or a shared link has no history to step through, so a control
   * driven by history would do nothing in exactly the case where it is the
   * only way out.
   */
  it("points somewhere real rather than stepping through history", async () => {
    await renderApp("#/languages");

    const back = screen.getByRole("link", { name: /^Back to / });
    expect(back.getAttribute("href")).toMatch(/^#?\//);
  });
});
