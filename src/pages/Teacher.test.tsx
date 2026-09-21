// @vitest-environment jsdom

/**
 * The teacher board, assembled.
 *
 * Every component on this page has its own suite — `ClassLimits`,
 * `ClassOverview`, `ClassGlance`, `SoundDetail`, `PupilList`, `PupilDetail`,
 * `CreateClass`, `SetSitting` — and this page had none. It is 440 lines, four
 * fetches and twelve pieces of state, and it was the only page in the product
 * without a test.
 *
 * That is not an oversight with no consequences. Three defects were found on
 * this route in one day once anything looked at it: it rendered two `<h1>`s,
 * its `<select>` measured 28px on WebKit, and axe had never run on it. All
 * three were invisible to the component suites, because a component suite
 * renders one component with props somebody chose.
 *
 * ## What this file is for
 *
 * The page's own header makes a claim the components cannot make for it:
 *
 * > Every figure on this page arrives from `GET /classes/:id/summary`, which
 * > converts accuracies to standings before they cross the class boundary.
 * > This screen therefore cannot show a pupil's score, because it is never
 * > sent one.
 *
 * The second sentence is a statement about the *server*. It is true today and
 * it is the wrong thing to rely on, because the consequence of it being wrong
 * one day is a child's pronunciation score on a teacher's screen — the single
 * outcome the class boundary exists to prevent. So the test below sends the
 * screen a score it should never have been sent and requires that it still
 * shows none. Defence in depth: the server not sending one, and the screen not
 * rendering one if it does.
 *
 * The rest is the states a component suite cannot reach — a server that is
 * down, a token that is missing, a class that does not exist — where the
 * failure mode is a blank screen or a crash rather than a wrong pixel.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { ClassSummary } from "../teacher/classSummary.js";

const CLASS_ID = "c-9f2a";

function reportable(): ClassSummary {
  return {
    reportable: true,
    joinedCount: 28,
    sounds: [
      {
        grapheme: "ʁ",
        justStarted: 9,
        gettingThere: 13,
        holding: 6,
        takes: 224,
        working: 22,
        notYet: 0,
      },
    ],
    attendance: [{ day: "2026-09-15", practisedCount: 19 }],
  };
}

/** What the server actually returns, before anything is done to it. */
function body(over: Record<string, unknown> = {}) {
  return {
    className: "Year 9 French",
    slug: "fr",
    expectedCount: 31,
    summary: reportable(),
    roster: [
      {
        label: "Maya",
        anonymous: false,
        days: ["2026-09-15"],
        lastPractised: "2026-09-15",
        workingOn: ["ʁ"],
        capture: { unusable: 1, total: 20 },
      },
    ],
    ...over,
  };
}

let responses: { status: number; json?: unknown; throws?: boolean }[] = [];
let calls: { url: string; headers: unknown }[] = [];

function installFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), headers: init.headers ?? {} });
      const next = responses.shift() ?? { status: 200, json: body() };
      if (next.throws === true) throw new TypeError("Failed to fetch");
      return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        json: async () => next.json,
      } as Response;
    }),
  );
}

function installStorage(): void {
  const data = new Map<string, string>();
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
}

async function open(search = `?class=${CLASS_ID}`) {
  const { Teacher } = await import("./Teacher.js");
  return render(
    <MemoryRouter initialEntries={[`/teacher${search}`]}>
      <Teacher />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  responses = [];
  calls = [];
  installStorage();
  installFetch();
});

afterEach(cleanup);

/**
 * The class name wherever it appears, which is deliberately more than once.
 *
 * Board 1i and board 1d both render and a media query picks one: `display:
 * none` also takes the loser out of the accessibility tree, so a screen reader
 * meets one rather than both, and a JavaScript breakpoint would have to guess
 * before first paint and get a rotation wrong. jsdom applies no CSS, so both
 * are present here — which is why this asks how many rather than which.
 */
function loaded(): HTMLElement[] {
  return screen.queryAllByText(/Year 9 French/);
}

/**
 * Every text node on the page, separately.
 *
 * Not `document.body.textContent`, which concatenates without separators: the
 * board renders a 28 beside where a planted 87 appeared, the two ran together
 * as "2887", and `\b87\b` then matched nothing. The first version of the
 * score test passed for that reason and survived a mutant that printed the
 * number straight onto the page. A node at a time has no seams to hide in.
 */
function textNodes(): string[] {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const out: string[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent?.trim() ?? "";
    if (text !== "") out.push(text);
  }
  return out;
}

describe("what the class boundary is for", () => {
  /**
   * The load-bearing one. A score is sent that should never have been sent,
   * and the screen must still show none.
   *
   * `87` is planted in three places a careless render would reach for: on the
   * summary, on the sound, and on the pupil. The assertion is on the rendered
   * text rather than on a prop, because what matters is what a teacher can
   * read off the screen — not which object the number was attached to.
   */
  it("shows no score even when the server sends one", async () => {
    responses = [
      {
        status: 200,
        json: body({
          summary: { ...reportable(), averageAccuracy: 87 },
          roster: [
            {
              label: "Maya",
              anonymous: false,
              days: ["2026-09-15"],
              lastPractised: "2026-09-15",
              workingOn: ["ʁ"],
              capture: { unusable: 1, total: 20 },
              accuracy: 87,
            },
          ],
        }),
      },
    ];

    await open();
    await waitFor(() => {
      expect(loaded()).not.toHaveLength(0);
    });

    expect(textNodes().filter((text) => /\b87\b/.test(text))).toEqual([]);
  });

  /**
   * Non-vacuity, and this file needs it more than most: the assertion above is
   * satisfied by a screen that rendered nothing at all, which is exactly what
   * a failed fetch produces. This proves the page had really drawn the class
   * when it was found to be showing no score.
   */
  it("really did render the class when it showed no score", async () => {
    responses = [{ status: 200, json: body() }];

    await open();

    await waitFor(() => {
      expect(loaded()).not.toHaveLength(0);
    });
    // The figures the board *does* carry, so "no 87" is a statement about
    // scores rather than about an empty page — and read the same way, so the
    // check proves the reader works as well as the screen.
    expect(textNodes().some((text) => /\b28\b/.test(text))).toBe(true);
  });
});

describe("when the server cannot answer", () => {
  it("says so, and says nothing about the class has changed", async () => {
    responses = [{ status: 0, throws: true }];

    await open();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Couldn’t reach the server/);
    expect(alert.textContent).toMatch(/Nothing about your class has changed/);
  });

  it("asks for a token rather than implying the class is empty", async () => {
    responses = [{ status: 401 }];

    await open();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/token/i);
    expect(loaded()).toHaveLength(0);
  });

  /**
   * And it takes the class down with it. Asserted from a loaded class rather
   * than a cold start, because a screen that never had one passes either way —
   * which is how the first version of this missed a mutant that left the
   * previous class on screen under a "this server requires a token" banner.
   */
  it("clears a class it was showing when the token stops working", async () => {
    responses = [{ status: 200, json: body() }];
    await open();
    await waitFor(() => {
      expect(loaded()).not.toHaveLength(0);
    });

    responses = [{ status: 401 }];
    fireEvent.change(screen.getByLabelText(/Class id/i), { target: { value: "c-other" } });

    await screen.findByRole("alert");
    expect(loaded()).toHaveLength(0);
  });

  it("distinguishes a class that does not exist from a server that is down", async () => {
    responses = [{ status: 404 }];

    await open();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/does not exist/i);
    expect(alert.textContent).not.toMatch(/Couldn’t reach/);
  });

  /**
   * A failure must not leave the previous class on screen. A teacher looking
   * at figures that quietly stopped updating is worse off than one told the
   * request failed, because nothing on the page says which they are seeing.
   */
  it("clears the class it was showing rather than leaving stale figures up", async () => {
    responses = [{ status: 200, json: body() }];
    await open();
    await waitFor(() => {
      expect(loaded()).not.toHaveLength(0);
    });

    responses = [{ status: 0, throws: true }];
    fireEvent.change(screen.getByLabelText(/Class id/i), { target: { value: "c-other" } });

    await screen.findByRole("alert");
    expect(loaded()).toHaveLength(0);
  });
});

describe("the limits", () => {
  /**
   * Board 1a: the limits are the first screen, not a settings page nobody
   * opens. They are on screen before any class is loaded, because the teacher
   * who expects a gradebook needs to be told there is none *before* they go
   * looking for one.
   */
  it("are visible before any class has loaded", async () => {
    await open("");

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/Sonare for a class/i);
    expect(document.body.textContent).toMatch(/grade|mark|score/i);
  });

  it("names the screen once, so a heading walk has one answer", async () => {
    responses = [{ status: 200, json: body() }];
    await open();
    await waitFor(() => {
      expect(loaded()).not.toHaveLength(0);
    });

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });
});

/**
 * The teacher key, on the client side of the guard.
 *
 * `server/middleware/classOwner.test.ts` covers the refusal. This covers the
 * half that decides whether a teacher is ever *able* to be recognised: the key
 * arrives once at creation, has to be kept, has to be sent on every later
 * request, and has to reach a second device by link. Any one of those missing
 * and the server guard simply locks the owner out of their own class.
 */
describe("the key that proves this device owns the class", () => {
  it("sends it on the summary request when it has one", async () => {
    installFetch();
    localStorage.setItem("sonare.teacherKeys", JSON.stringify({ [CLASS_ID]: "k-abc" }));
    responses = [{ status: 200, json: body() }];

    await open();
    await waitFor(() => {
      expect(loaded()).not.toHaveLength(0);
    });

    const headers = (calls.at(-1)?.headers ?? {}) as Record<string, string>;
    expect(headers["x-teacher-key"]).toBe("k-abc");
  });

  /**
   * And takes it from the URL, so a teacher opening their link on a second
   * device is recognised there too — which is the entire point of the link
   * being a link rather than a note in a drawer.
   */
  it("accepts a key from the link and keeps it", async () => {
    installFetch();
    responses = [{ status: 200, json: body() }];

    await open(`?class=${CLASS_ID}&key=k-from-link`);
    await waitFor(() => {
      expect(loaded()).not.toHaveLength(0);
    });

    const headers = (calls.at(-1)?.headers ?? {}) as Record<string, string>;
    expect(headers["x-teacher-key"]).toBe("k-from-link");
    // Kept, so the next visit needs no link.
    expect(JSON.parse(localStorage.getItem("sonare.teacherKeys") ?? "{}")).toEqual({
      [CLASS_ID]: "k-from-link",
    });
  });

  /**
   * Keys are kept per class. One teacher may own several, and a single slot
   * would mean creating a second class silently revoked access to the first.
   */
  it("keeps one key per class rather than one key", async () => {
    installFetch();
    localStorage.setItem("sonare.teacherKeys", JSON.stringify({ "other-class": "k-other" }));
    responses = [{ status: 200, json: body() }];

    await open(`?class=${CLASS_ID}&key=k-this`);
    await waitFor(() => {
      expect(loaded()).not.toHaveLength(0);
    });

    expect(JSON.parse(localStorage.getItem("sonare.teacherKeys") ?? "{}")).toEqual({
      "other-class": "k-other",
      [CLASS_ID]: "k-this",
    });
  });

  it("sends no key header at all when it has none", async () => {
    installFetch();
    responses = [{ status: 200, json: body() }];

    await open();
    await waitFor(() => {
      expect(loaded()).not.toHaveLength(0);
    });

    const headers = (calls.at(-1)?.headers ?? {}) as Record<string, string>;
    expect("x-teacher-key" in headers).toBe(false);
  });

  /**
   * Unreadable storage is no keys, never a crash. This screen carries the only
   * route to "leave the class" and "delete everything" for whoever is looking
   * at it, and a thrown JSON parse would take those down over a convenience.
   */
  it("survives storage holding nonsense", async () => {
    installFetch();
    localStorage.setItem("sonare.teacherKeys", "not json");
    responses = [{ status: 200, json: body() }];

    await expect(open()).resolves.toBeDefined();
    await waitFor(() => {
      expect(loaded()).not.toHaveLength(0);
    });
  });
});
