// @vitest-environment jsdom

/**
 * The screen that makes the deletion endpoint reachable, and the export beside
 * it.
 *
 * Most of these are about the two ways this screen can be quietly wrong rather
 * than about it rendering. It can destroy data it was not asked to destroy —
 * the other learner on a shared classroom tablet, whose keys sit next to this
 * learner's under a different name suffix. And it can *claim* a deletion that
 * did not happen, which is worse than failing, because the learner stops
 * asking.
 *
 * jsdom exposes `localStorage` as a bare object with no methods, so every test
 * installs a real in-memory Storage. That is not a formality here: this screen
 * exists to remove things from storage, so a stub without `removeItem` would
 * make every clear silently pass.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { Settings } from "./Settings.js";
import { LANGUAGES } from "../activities/languages/index.js";

/** The real thing, keyed so a test can read what is left behind. */
let store: Map<string, string>;

function installStorage(seed?: Record<string, string>): void {
  store = new Map(Object.entries(seed ?? {}));
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

const LEARNER = "marie";
/** The other learner on the same device. Nothing here may touch their keys. */
const OTHER = "luc";
const TOKEN = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.1.signature";

function language(index: number) {
  const found = LANGUAGES[index];
  if (found === undefined) throw new Error(`no language at ${index}`);
  return found;
}

const FIRST = language(0);

/** One key of every learner-scoped kind, for the named learner. */
function keysFor(name: string): Record<string, string> {
  return {
    [`sonare.learnerId.v1.${name}`]: "11111111-2222-4333-8444-555555555555",
    [`sonare.sync.token.v1.${name}`]: TOKEN,
    [`sonare.streak.v1.${name}`]: JSON.stringify({ days: ["2026-09-01"], current: 1, longest: 3 }),
    [`sonare.sync.dirty.v1.${name}`]: JSON.stringify({ progress: [FIRST.slug], skills: [], streak: true }),
    [`sonare.progress.v2.${FIRST.slug}.${name}`]: JSON.stringify({
      index: 1,
      progress: [{ activityId: 1, attempts: [], best: 80, passed: true, skipped: false }],
      finished: false,
    }),
    [`sonare.skills.v1.${FIRST.slug}.${name}`]: JSON.stringify({
      ment: { grapheme: "ment", samples: [{ at: "2026-09-01T10:00:00.000Z", accuracy: 61 }] },
    }),
  };
}

function seedBothLearners(): void {
  installStorage({
    "sonare.learnerName": LEARNER,
    ...keysFor(LEARNER),
    ...keysFor(OTHER),
  });
}

/** A server export body, shaped as the route returns it. */
function exportBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 1,
    exportedAt: "2026-09-09T10:00:00.000Z",
    learnerId: "11111111-2222-4333-8444-555555555555",
    collections: {
      attempts: [{ at: "2026-09-01T10:00:00.000Z", referenceText: "Bonjour" }],
      diagnostics: [],
      ratelimits: [{ _id: "scoring-learner:x:0", hits: 2 }],
      progress: [{ slug: FIRST.slug, entries: [] }],
      skills: [{ slug: FIRST.slug, skills: [] }],
      streaks: { days: ["2026-09-01"], longest: 3 },
      learners: { _id: "x", displayName: "Marie" },
    },
    truncated: { attempts: false, diagnostics: false },
    ...overrides,
  };
}

function ok(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function fail(status: number, userMessage: string): Response {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({ error: { code: "PROVIDER_UNAVAILABLE", userMessage } }),
  } as unknown as Response;
}

/** Every object URL the page created, so a download is observable. */
let saved: string[];
let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
let clicked: string[];

function view() {
  return render(
    <MemoryRouter>
      <Settings />
    </MemoryRouter>,
  );
}

/** Reads the JSON out of whatever Blob the page handed to createObjectURL. */
async function savedFile(): Promise<Record<string, unknown>> {
  const blob = createObjectURL.mock.calls[0]?.[0] as Blob | undefined;
  if (blob === undefined) throw new Error("nothing was saved");
  return JSON.parse(await blob.text()) as Record<string, unknown>;
}

function typeConfirmation(word: string): void {
  fireEvent.change(screen.getByLabelText("Type DELETE to confirm"), { target: { value: word } });
}

beforeEach(() => {
  seedBothLearners();
  saved = [];
  clicked = [];
  createObjectURL = vi.fn((blob: Blob) => {
    const url = `blob:${saved.length}`;
    saved.push(url);
    void blob;
    return url;
  });
  revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });

  // jsdom's anchor click would try to navigate. Recording it is the only part
  // that matters: the file is in the Blob, not in the click.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push(this.download);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("exporting", () => {
  it("asks the server with the learner's token and saves what came back", async () => {
    const doFetch = vi.fn(() => Promise.resolve(ok(exportBody())));
    vi.stubGlobal("fetch", doFetch);
    view();

    fireEvent.click(screen.getByRole("button", { name: "Export my data" }));

    await waitFor(() => expect(clicked).toHaveLength(1));
    const [url, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/learners/me/export");
    // The bare id authorises nothing — only the signed token does.
    expect((init.headers as Record<string, string>)["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(clicked[0]).toMatch(/^sonare-data-export-\d{4}-\d{2}-\d{2}\.json$/);
    expect(revokeObjectURL).toHaveBeenCalled();
  });

  it("saves the server's payload unaltered", async () => {
    /**
     * The file is the record. A screen that summarised or reshaped it on the
     * way through would be handing over its own account of the data instead of
     * the data — and that account is what a learner would use to check a
     * deletion against.
     */
    const body = exportBody();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(ok(body))));
    view();

    fireEvent.click(screen.getByRole("button", { name: "Export my data" }));

    await waitFor(() => expect(clicked).toHaveLength(1));
    expect((await savedFile())["server"]).toEqual(body);
  });

  it("includes this device's own copy, because the deletion clears it too", async () => {
    /**
     * An export that covered less than the delete would leave a learner unable
     * to keep the part they are about to lose. The device's copy is also the
     * richer one: every individual take lives here and never reaches the
     * server.
     */
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(ok(exportBody()))));
    view();

    fireEvent.click(screen.getByRole("button", { name: "Export my data" }));

    await waitFor(() => expect(clicked).toHaveLength(1));
    const device = (await savedFile())["device"] as {
      learnerName: string;
      streak: { longest: number };
      pendingSync: { streak: boolean };
      languages: Array<{ slug: string; progress: { index: number } }>;
    };
    expect(device.learnerName).toBe(LEARNER);
    expect(device.streak.longest).toBe(3);
    expect(device.pendingSync.streak).toBe(true);
    expect(device.languages.find((l) => l.slug === FIRST.slug)?.progress.index).toBe(1);
  });

  it("carries no other learner's record", async () => {
    // Two learners on one device have separate keys under separate name
    // suffixes. A prefix scan over localStorage would have pooled them, which
    // is the bug the per-learner keys exist to prevent.
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(ok(exportBody()))));
    view();

    fireEvent.click(screen.getByRole("button", { name: "Export my data" }));

    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(JSON.stringify((await savedFile())["device"])).not.toContain(OTHER);
  });

  it("names every collection and how much was in it", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(ok(exportBody()))));
    view();

    fireEvent.click(screen.getByRole("button", { name: "Export my data" }));

    const report = await screen.findByRole("status");
    // Every collection, including the empty one: a name missing because it
    // was empty is indistinguishable from one the export forgot.
    for (const name of ["attempts", "diagnostics", "ratelimits", "progress", "skills", "streaks", "learners"]) {
      expect(report).toHaveTextContent(name);
    }

    /** The count cell in the row naming this collection. */
    const countFor = (name: string): string | null => {
      const row = [...report.querySelectorAll("tbody tr")].find(
        (tr) => tr.querySelector("td")?.textContent === name,
      );
      return row?.querySelectorAll("td")[1]?.textContent ?? null;
    };
    // An empty collection reads as zero, not as an absence.
    expect(countFor("diagnostics")).toBe("0");
    // `streaks` and `learners` hold one document rather than a list, because
    // the export's keys are collection names. One document is one record.
    expect(countFor("streaks")).toBe("1");
    expect(countFor("learners")).toBe("1");
  });

  it("says when the server had to cut a trail short", async () => {
    // Otherwise a learner's history just stops at a round number.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(ok(exportBody({ truncated: { attempts: true, diagnostics: false } })))),
    );
    view();

    fireEvent.click(screen.getByRole("button", { name: "Export my data" }));

    const capped = await screen.findByText(/Capped by the server/);
    expect(capped).toHaveTextContent("attempts holds only its most recent records");
  });

  it("saves nothing when the server refuses, and says the server's own words", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(fail(503, "Your data could not be exported. Please try again."))));
    view();

    fireEvent.click(screen.getByRole("button", { name: "Export my data" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Your data could not be exported.");
    expect(clicked).toHaveLength(0);
  });

  it("saves nothing when the request never lands", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    view();

    fireEvent.click(screen.getByRole("button", { name: "Export my data" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach the server");
    expect(clicked).toHaveLength(0);
  });
});

describe("deleting everything", () => {
  it("will not send until the word is typed", async () => {
    // A bare button next to an irreversible action with no undo behind it is
    // not a confirmation.
    const doFetch = vi.fn(() => Promise.resolve(ok({ deleted: true, attempts: 0, diagnostics: 0 })));
    vi.stubGlobal("fetch", doFetch);
    view();

    const button = screen.getByRole("button", { name: "Delete everything" });
    expect(button).toBeDisabled();

    typeConfirmation("delete my data");
    expect(button).toBeDisabled();

    fireEvent.click(button);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("accepts the word whatever case it is typed in", async () => {
    // The deliberate act being asked for is typing a specific word, not
    // defeating a phone keyboard's autocapitalise.
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(ok({ deleted: true, attempts: 0, diagnostics: 0 }))));
    view();

    typeConfirmation("  delete  ");

    expect(screen.getByRole("button", { name: "Delete everything" })).toBeEnabled();
  });

  it("calls the endpoint that already exists, with the learner's token", async () => {
    const doFetch = vi.fn(() => Promise.resolve(ok({ deleted: true, attempts: 3, diagnostics: 1 })));
    vi.stubGlobal("fetch", doFetch);
    view();

    typeConfirmation("DELETE");
    fireEvent.click(screen.getByRole("button", { name: "Delete everything" }));

    await screen.findByRole("status");
    const [url, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/learners/me");
    expect(init.method).toBe("DELETE");
    expect((init.headers as Record<string, string>)["authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("reports the counts the endpoint returned, and no others", async () => {
    /**
     * A count computed on this screen could report a successful deletion of
     * records that are still there. The endpoint returns a figure for the two
     * trails and none for the rest, so the rest are named without numbers —
     * a fabricated count on a deletion report looks like evidence.
     */
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(ok({ deleted: true, attempts: 3, diagnostics: 1 }))));
    view();

    typeConfirmation("DELETE");
    fireEvent.click(screen.getByRole("button", { name: "Delete everything" }));

    const report = await screen.findByRole("status");
    expect(report).toHaveTextContent("3 attempts");
    expect(report).toHaveTextContent("1 error report");
    expect(report).toHaveTextContent("the endpoint returns no count for those");
  });

  it("clears this learner's every local key", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(ok({ deleted: true, attempts: 1, diagnostics: 0 }))));
    view();

    typeConfirmation("DELETE");
    fireEvent.click(screen.getByRole("button", { name: "Delete everything" }));

    await screen.findByRole("status");
    for (const key of Object.keys(keysFor(LEARNER))) {
      expect(store.has(key)).toBe(false);
    }
  });

  it("leaves the other learner on the device untouched", async () => {
    /**
     * The property this screen most has to get right. Two learners on one
     * shared device previously collided into a single server identity and
     * pooled their records; a classroom tablet is the stated commercial
     * surface. One learner erasing the other's practice would be the same
     * mistake with a worse outcome.
     */
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(ok({ deleted: true, attempts: 1, diagnostics: 0 }))));
    view();

    typeConfirmation("DELETE");
    fireEvent.click(screen.getByRole("button", { name: "Delete everything" }));

    await screen.findByRole("status");
    for (const [key, value] of Object.entries(keysFor(OTHER))) {
      expect(store.get(key)).toBe(value);
    }
  });

  it("keeps the device's copy when the server refuses", async () => {
    /**
     * A part-way server deletion is idempotent and retrying finishes it. But
     * clearing the only remaining copy of a learner's practice because the
     * server failed would destroy data the failure never touched.
     */
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(fail(503, "Your data was not fully deleted. Please try again."))));
    view();

    typeConfirmation("DELETE");
    fireEvent.click(screen.getByRole("button", { name: "Delete everything" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("not fully deleted");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(store.has(`sonare.streak.v1.${LEARNER}`)).toBe(true);
  });

  it("keeps the device's copy when the request never lands", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    view();

    typeConfirmation("DELETE");
    fireEvent.click(screen.getByRole("button", { name: "Delete everything" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing was deleted");
    expect(store.has(`sonare.progress.v2.${FIRST.slug}.${LEARNER}`)).toBe(true);
  });

  it("cannot be fired twice from one confirmation", async () => {
    // The word is cleared on success, so a second click after a completed
    // deletion has nothing to send.
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(ok({ deleted: true, attempts: 1, diagnostics: 0 }))));
    view();

    typeConfirmation("DELETE");
    fireEvent.click(screen.getByRole("button", { name: "Delete everything" }));

    await screen.findByRole("status");
    expect(screen.getByRole("button", { name: "Delete everything" })).toBeDisabled();
  });
});

describe("with no identity available", () => {
  it("says so rather than reporting a deletion that never happened", async () => {
    /**
     * Identity is off when the server has no signing secret, and registration
     * then returns nothing. Clearing the device on the strength of that would
     * destroy the learner's only copy while the server kept its own.
     */
    installStorage({ "sonare.learnerName": LEARNER, ...keysFor(LEARNER) });
    store.delete(`sonare.sync.token.v1.${LEARNER}`);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(fail(503, "This feature is not available right now."))));
    view();

    typeConfirmation("DELETE");
    fireEvent.click(screen.getByRole("button", { name: "Delete everything" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "could not identify itself to the server",
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(store.has(`sonare.streak.v1.${LEARNER}`)).toBe(true);
  });
});

describe("the theme control", () => {
  /**
   * Nothing stamped `data-theme` before this: tokens.css had a complete
   * measured dark palette and the only way to reach it was to change the
   * operating system's own appearance setting.
   *
   * These run against the real document, so `data-theme` is cleaned off the
   * root between them — a leaked attribute would let the next test's assertion
   * pass for the wrong reason.
   */
  afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
  });

  it("offers three states, not two", () => {
    view();
    for (const name of ["System", "Light", "Dark"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("starts on system when nothing is stored, and stamps nothing", () => {
    view();
    expect(screen.getByRole("button", { name: "System" })).toHaveAttribute("aria-pressed", "true");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("stamps the root and remembers the choice", () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: "Dark" }));

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(store.get("sonare.theme")).toBe("dark");
    expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "System" })).toHaveAttribute("aria-pressed", "false");
  });

  it("reads the stored choice back on load", () => {
    installStorage({ "sonare.learnerName": LEARNER, "sonare.theme": "dark" });
    view();
    // The control has to agree with the document the inline script already
    // stamped; a control showing "System" over a dark page would be reporting
    // a state the app is not in.
    expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
  });

  /**
   * The state that is an absence. Choosing light on a dark OS has to win,
   * which is why the media block is guarded with :not([data-theme="light"]) —
   * so "light" is stamped, and only "system" is unstamped.
   */
  it("unstamps the root when going back to system", () => {
    installStorage({ "sonare.learnerName": LEARNER, "sonare.theme": "dark" });
    view();

    fireEvent.click(screen.getByRole("button", { name: "System" }));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(store.get("sonare.theme")).toBe("system");
  });

  it("stamps light explicitly, so choosing light on a dark OS wins", () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: "Light" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("explains what the current choice does", () => {
    view();
    expect(screen.getByText("Follows your device's appearance setting.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    expect(screen.getByText("Always dark, whatever your device is set to.")).toBeInTheDocument();
  });

  it("names the group without renaming one of its buttons", () => {
    /**
     * A <label htmlFor> heading a group of three would associate its text with
     * one of them and rename it, which is how CaptureSettings' middle
     * sensitivity button lost its own accessible name. The heading is a plain
     * element wired up with aria-labelledby instead.
     */
    view();
    expect(screen.getByRole("group", { name: "Theme" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Light" })).toBeInTheDocument();
  });

  it("still renders, and still switches, when storage is unavailable", () => {
    /**
     * jsdom's own localStorage is a bare object with no methods, and a real
     * browser throws in private mode. Either way the screen has to render as a
     * learner with no stored preference — and the choice must still apply for
     * the rest of the visit, because the document write does not depend on
     * storage succeeding.
     */
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: () => {
          throw new DOMException("The operation is insecure.", "SecurityError");
        },
        setItem: () => {
          throw new DOMException("The operation is insecure.", "SecurityError");
        },
      },
    });

    view();
    expect(screen.getByRole("button", { name: "System" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
  });

  it("does not disturb the destructive controls", () => {
    // The appearance section sits above the delete section. A learner
    // switching theme must not arm anything below it.
    view();
    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    expect(screen.getByRole("button", { name: "Delete everything" })).toBeDisabled();
  });
});
