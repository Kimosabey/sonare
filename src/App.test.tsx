// @vitest-environment jsdom

/**
 * Routing, and the two decisions in it that are load-bearing rather than
 * cosmetic.
 *
 * The `key={slug}` on the activity route: React Router does *not* remount a
 * component when only a route param changes, so /french -> /spanish matches
 * the same `path="/:slug"` element and the previous language's session state
 * survives — progress, the started flag, briefly even the old target text. A
 * learner switching language would find themselves partway through a session
 * they never began, in a language they just left. That is a one-word fix that
 * a refactor can silently undo, and nothing else would fail.
 *
 * And HashRouter: URLs stay `#/`-prefixed, which survives a direct visit or a
 * refresh through an ngrok tunnel with no server-side rewrite. A plain
 * BrowserRouter 404s on a fresh visit to /diagnostics — which is exactly how
 * the internal screens are reached, since there is no nav link to either
 * anywhere in the product.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, useRef } from "react";
import { LANGUAGES } from "./activities/languages/index.js";

/** Records every mount, so remount-versus-rerender is observable. */
const mounts: string[] = [];

vi.mock("./pages/LanguagePicker.js", () => ({
  LanguagePicker: () => {
    return <p>pick a language</p>;
  },
}));
vi.mock("./pages/ActivityTest.js", () => ({
  ActivityTest: () => {
    // A fresh id per mount, pushed once, so remount-versus-rerender is
    // observable from the outside — which is the whole point of the key.
    const id = useRef(Math.random().toString(36).slice(2));
    useEffect(() => {
      mounts.push(id.current);
    }, []);
    return <p>activity screen</p>;
  },
}));
vi.mock("./pages/Diagnostics.js", () => ({ Diagnostics: () => <p>diagnostics screen</p> }));
vi.mock("./pages/FixtureRunner.js", () => ({ FixtureRunner: () => <p>fixture screen</p> }));

async function visit(hash: string) {
  window.location.hash = hash;
  const { App } = await import("./App.js");
  return render(<App />);
}

beforeEach(() => {
  mounts.length = 0;
  window.location.hash = "";
});

afterEach(() => {
  cleanup();
  vi.resetModules();
});

describe("the four screens", () => {
  it("opens on the language picker", async () => {
    await visit("#/");

    expect(screen.getByText("pick a language")).toBeInTheDocument();
  });

  it("routes a language slug to the activity screen", async () => {
    const slug = LANGUAGES[0]?.slug ?? "french";
    await visit(`#/${slug}`);

    expect(screen.getByText("activity screen")).toBeInTheDocument();
  });

  it("reaches the internal screens by URL alone", async () => {
    /**
     * There is no nav link to either anywhere in the product UI, which is
     * deliberate — a learner should not find the diagnostics dashboard. That
     * makes typing the URL the only route in, so it has to work on a cold
     * visit.
     */
    await visit("#/diagnostics");
    expect(await screen.findByText("diagnostics screen")).toBeInTheDocument();

    cleanup();
    vi.resetModules();
    await visit("#/fixture");
    expect(await screen.findByText("fixture screen")).toBeInTheDocument();
  });

  it("navigates by hash, so a refresh through a tunnel survives", async () => {
    /**
     * The reason for HashRouter over BrowserRouter, asserted by watching where
     * a navigation actually lands. Everything after `#` never reaches the
     * server, so a fresh visit to #/diagnostics needs no rewrite rule — and
     * the fixture runs over an ngrok tunnel, where there is nowhere to put
     * one. Under BrowserRouter this navigation would change the *path*, and a
     * refresh at that URL would 404.
     */
    const [a, b] = LANGUAGES;
    if (!a || !b) throw new Error("need two languages");
    await visit(`#/${a.slug}`);

    fireEvent.change(screen.getByLabelText("Switch language"), { target: { value: b.slug } });

    await waitFor(() => expect(window.location.hash).toBe(`#/${b.slug}`));
    expect(window.location.pathname).toBe("/");
  });
});

describe("switching language really starts over", () => {
  it("remounts the activity screen when only the slug changes", async () => {
    /**
     * The bug this guards. Same matched route, different param: React Router
     * re-renders rather than remounting, so without `key={slug}` the previous
     * language's progress, `started` flag and target text all carry over. A
     * learner would land mid-session in a language they had just left.
     */
    const [a, b] = LANGUAGES;
    if (!a || !b) throw new Error("need two languages");
    await visit(`#/${a.slug}`);
    await waitFor(() => expect(mounts).toHaveLength(1));

    fireEvent.change(screen.getByLabelText("Switch language"), { target: { value: b.slug } });

    await waitFor(() => expect(mounts).toHaveLength(2));
    expect(mounts[0]).not.toBe(mounts[1]);
  });

  it("offers every shipped language in the switcher", async () => {
    const slug = LANGUAGES[0]?.slug ?? "french";
    await visit(`#/${slug}`);

    for (const language of LANGUAGES) {
      expect(screen.getByRole("option", { name: language.label })).toBeInTheDocument();
    }
  });

  it("shows the language currently being learned as selected", async () => {
    // A switcher showing the wrong language is worse than no switcher: it
    // makes a learner think they are somewhere they are not.
    const second = LANGUAGES[1];
    if (!second) throw new Error("need two languages");
    await visit(`#/${second.slug}`);

    expect((screen.getByLabelText("Switch language") as HTMLSelectElement).value).toBe(second.slug);
  });
});

describe("the breadcrumb", () => {
  it("stays hidden on the front door, where there is nowhere to go back to", async () => {
    await visit("#/");

    expect(screen.queryByLabelText("Breadcrumb")).not.toBeInTheDocument();
  });

  it("gives a way back that is not the browser's back button", async () => {
    /**
     * There was no in-app route back to the picker at all — the only way out
     * of a language was the browser's own back button, which on a phone in
     * standalone mode may not be visible.
     */
    const slug = LANGUAGES[0]?.slug ?? "french";
    await visit(`#/${slug}`);

    expect(screen.getByRole("link", { name: "Sonare" })).toHaveAttribute("href", "#/");
  });

  it("names the internal screens rather than showing a bare crumb", async () => {
    await visit("#/diagnostics");
    await screen.findByText("diagnostics screen");

    const crumb = screen.getByLabelText("Breadcrumb");
    expect(crumb).toHaveTextContent("Diagnostics");
  });

  it("shows no language switcher on the internal screens", async () => {
    // Neither is scoped to a language, so a switcher there would navigate
    // somewhere unrelated to what is on screen.
    await visit("#/fixture");
    await screen.findByText("fixture screen");

    expect(screen.queryByLabelText("Switch language")).not.toBeInTheDocument();
  });

  it("hides the decorative separators from a screen reader", async () => {
    // Read aloud, a chevron between every crumb is noise on every screen.
    const slug = LANGUAGES[0]?.slug ?? "french";
    await visit(`#/${slug}`);

    const separators = [...screen.getByLabelText("Breadcrumb").querySelectorAll("span")].filter(
      (n) => (n.textContent ?? "").trim() === "›",
    );
    expect(separators.length).toBeGreaterThan(0);
    for (const separator of separators) expect(separator).toHaveAttribute("aria-hidden", "true");
  });
});

describe("the header", () => {
  it("names the language being learned", async () => {
    const language = LANGUAGES[0];
    if (!language) throw new Error("need a language");
    await visit(`#/${language.slug}`);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      `${language.label} speech activity`,
    );
  });

  it("marks the internal screens as internal", async () => {
    /**
     * These carry every learner's spoken phrases and the spend figures. The
     * eyebrow is the only thing on screen saying so, which matters when the
     * dashboard is open on a shared display during a fixture run.
     */
    await visit("#/diagnostics");
    await screen.findByText("diagnostics screen");

    expect(screen.getByText("Sonare · internal diagnostics")).toBeInTheDocument();
  });

  it("falls back to a generic heading for an unknown slug", async () => {
    // A hand-edited URL or a stale bookmark must not render a broken title.
    await visit("#/klingon");

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Speech activity");
  });
});

describe("code splitting", () => {
  it("suspends only for the internal screens, never for the learner path", async () => {
    /**
     * The picker and activity screens are statically imported precisely so
     * they never flash a fallback: the learner flow is what should feel fast,
     * while ~30 kB of internal tooling can afford a fetch on the rare visit
     * that wants it.
     */
    await visit("#/");

    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(screen.getByText("pick a language")).toBeInTheDocument();
  });
});
