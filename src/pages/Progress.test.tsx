// @vitest-environment jsdom

/**
 * The learner's own record over weeks — the screen the whole persistence
 * effort was for.
 *
 * Every figure comes from data the app used to discard when the tab closed, so
 * the tests are mostly about *not inventing* the parts that are still missing:
 * a trend against no history, a practice day that was never recorded, a
 * completion count for a language never started.
 *
 * jsdom exposes `localStorage` as a bare object with no methods, so every test
 * installs a real in-memory Storage.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Progress } from "./Progress.js";
import { LANGUAGES } from "../activities/languages/index.js";

function installStorage(seed?: Record<string, string>): void {
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
}

const LEARNER = "marie";

function set(index: number) {
  const found = LANGUAGES[index];
  if (found === undefined) throw new Error(`no language at ${index}`);
  return found;
}

const FIRST = set(0);

function seed(options: {
  days?: string[];
  longest?: number;
  skills?: Array<[grapheme: string, accuracies: number[]]>;
  passed?: number;
}): void {
  const data: Record<string, string> = { "sonare.learnerName": LEARNER };

  if (options.days !== undefined) {
    data[`sonare.streak.v1.${LEARNER}`] = JSON.stringify({
      days: options.days,
      current: 0,
      longest: options.longest ?? 0,
    });
  }
  if (options.skills !== undefined) {
    const store: Record<string, unknown> = {};
    for (const [grapheme, accuracies] of options.skills) {
      store[grapheme] = {
        grapheme,
        samples: accuracies.map((accuracy, i) => ({
          at: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T10:00:00.000Z`,
          accuracy,
        })),
      };
    }
    data[`sonare.skills.v1.${FIRST.slug}.${LEARNER}`] = JSON.stringify(store);
  }
  if (options.passed !== undefined) {
    data[`sonare.progress.v2.${FIRST.slug}.${LEARNER}`] = JSON.stringify({
      index: 0,
      progress: FIRST.activities.slice(0, options.passed).map((a) => ({
        activityId: a.id,
        attempts: [{ activityId: a.id, result: {}, accuracy: 85, at: "2026-09-07T10:00:00.000Z" }],
        best: 85,
        passed: true,
        skipped: false,
      })),
      finished: false,
    });
  }

  installStorage(data);
}

function show(slug: string = FIRST.slug) {
  return render(
    <MemoryRouter initialEntries={[`/${slug}/progress`]}>
      <Routes>
        <Route path="/:slug/progress" element={<Progress />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  installStorage();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-07T12:00:00"));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the sounds", () => {
  it("lists a syllable with its now and before", () => {
    seed({ skills: [["ment", [20, 22, 24, 80, 82, 84, 86, 88]]] });
    show();

    expect(screen.getByText("ment")).toBeInTheDocument();
    // Recent five average 84; the earlier three average 22.
    expect(screen.getByRole("cell", { name: "84" })).toBeInTheDocument();
  });

  it("shows a dash rather than a change it cannot measure", () => {
    /**
     * The honesty case. `trendFor` returns a null `before` until there is
     * history either side of the window, and rendering that as "no change"
     * would be a claim about data that does not exist.
     */
    seed({ skills: [["ment", [40, 45]]] });
    show();

    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText(/no change/i)).not.toBeInTheDocument();
  });

  it("explains the dash once, below the table", () => {
    // A dash with no explanation reads as a bug.
    seed({ skills: [["ment", [40, 45]]] });
    show();

    expect(screen.getByText(/not enough history to compare against yet/i)).toBeInTheDocument();
  });

  it("does not explain a dash that is not there", () => {
    seed({ skills: [["ment", [20, 22, 24, 80, 82, 84, 86, 88]]] });
    show();

    expect(screen.queryByText(/not enough history to compare/i)).not.toBeInTheDocument();
  });

  it("marks a rise and a fall with a glyph, not colour alone", () => {
    // Colour alone fails for a learner who cannot distinguish it, so the
    // direction is also a character.
    seed({
      skills: [
        ["up", [20, 20, 20, 90, 90, 90, 90, 90]],
        ["down", [90, 90, 90, 20, 20, 20, 20, 20]],
      ],
    });
    show();

    expect(screen.getByText(/↑/)).toBeInTheDocument();
    expect(screen.getByText(/↓/)).toBeInTheDocument();
  });

  it("shows every sound, not just the weakest few", () => {
    /**
     * This is where a learner looks for the one they have fixed, and a list
     * capped at the worst three hides exactly that.
     */
    seed({
      skills: [
        ["aaa", [10, 10, 10, 12, 12, 12, 12, 12]],
        ["bbb", [11, 11, 11, 13, 13, 13, 13, 13]],
        ["ccc", [12, 12, 12, 14, 14, 14, 14, 14]],
        ["fixed", [20, 20, 20, 95, 95, 95, 95, 95]],
      ],
    });
    show();

    expect(screen.getByText("fixed")).toBeInTheDocument();
  });

  it("says nothing is measured yet rather than showing an empty table", () => {
    seed({});
    show();

    expect(screen.getByText(/nothing measured yet/i)).toBeInTheDocument();
    // Queried by its own column header rather than by role "table" — the
    // practice calendar is also a table, so the looser query matched it and
    // the assertion was testing the wrong element entirely.
    expect(screen.queryByRole("columnheader", { name: /syllable/i })).not.toBeInTheDocument();
  });

  it("counts the takes behind each figure", () => {
    // So a learner can tell a settled number from one drawn on two samples.
    seed({ skills: [["ment", [20, 22, 24, 80, 82, 84, 86, 88]]] });
    show();

    expect(screen.getByRole("cell", { name: "8" })).toBeInTheDocument();
  });
});

describe("the practice calendar", () => {
  it("draws eight weeks of squares", () => {
    seed({ days: ["2026-09-07"] });
    show();

    expect(screen.getAllByRole("cell").filter((c) => c.className.includes("calendar-day"))).toHaveLength(56);
  });

  it("fills the days that were practised", () => {
    seed({ days: ["2026-09-05", "2026-09-07"] });
    show();

    const on = screen
      .getAllByRole("cell")
      .filter((c) => c.className.includes("calendar-day-on"));
    expect(on).toHaveLength(2);
  });

  it("labels every square with its date and state", () => {
    /**
     * Without labels this is an unlabelled wall of cells to a screen reader —
     * a decorative grid where the meaning is entirely in the fill.
     */
    seed({ days: ["2026-09-07"] });
    show();

    expect(screen.getByRole("cell", { name: "2026-09-07: practised" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "2026-09-06: no practice" })).toBeInTheDocument();
  });

  it("ends on today, so the newest square is the one just filled", () => {
    seed({ days: ["2026-09-07"] });
    show();

    const cells = screen.getAllByRole("cell").filter((c) => c.className.includes("calendar-day"));
    expect(cells[55]).toHaveAttribute("aria-label", "2026-09-07: practised");
  });

  it("uses the learner's local day, not UTC", () => {
    /**
     * Practice is recorded against the learner's own calendar, so the grid has
     * to be built the same way — a UTC grid puts a late-night session on the
     * wrong square for half the world.
     */
    vi.setSystemTime(new Date("2026-09-07T23:40:00"));
    seed({ days: ["2026-09-07"] });
    show();

    expect(screen.getByRole("cell", { name: "2026-09-07: practised" })).toBeInTheDocument();
  });

  it("reports the best run even with no current streak", () => {
    // Losing the achievement along with the streak makes a missed day cost
    // twice.
    seed({ days: ["2026-07-01", "2026-07-02"], longest: 9 });
    show();

    expect(screen.getByText(/best run: 9/i)).toBeInTheDocument();
  });
});

describe("activities", () => {
  it("counts what has been passed", () => {
    seed({ passed: 3 });
    show();

    expect(screen.getByText(`3 of ${FIRST.activities.length} passed`)).toBeInTheDocument();
  });

  it("offers a count to try when nothing has been started", () => {
    // Rather than "0 of 10 passed", which reads as a failure on a screen
    // nobody has used yet.
    seed({});
    show();

    expect(screen.getByText(`${FIRST.activities.length} to try`)).toBeInTheDocument();
  });
});

describe("getting elsewhere", () => {
  it("offers practice and the way back", () => {
    seed({});
    show();

    expect(screen.getByRole("link", { name: new RegExp(`practise ${FIRST.label}`, "i") })).toHaveAttribute(
      "href",
      `/${FIRST.slug}`,
    );
    expect(screen.getByRole("link", { name: /back to today/i })).toHaveAttribute("href", "/");
  });

  it("handles a language that does not exist", () => {
    // A hand-edited URL or a stale bookmark.
    seed({});
    show("klingon");

    expect(screen.getByRole("heading", { name: /language not found/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to today/i })).toBeInTheDocument();
  });
});

describe("surviving bad stored data", () => {
  it("renders on corrupt records", () => {
    installStorage({
      "sonare.learnerName": LEARNER,
      [`sonare.streak.v1.${LEARNER}`]: "{not json",
      [`sonare.skills.v1.${FIRST.slug}.${LEARNER}`]: "[]",
      [`sonare.progress.v2.${FIRST.slug}.${LEARNER}`]: "nope",
    });

    expect(() => show()).not.toThrow();
    expect(screen.getByRole("heading", { level: 2 })).toBeInTheDocument();
  });

  it("renders when storage refuses entirely", () => {
    installStorage();
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });

    expect(() => show()).not.toThrow();
  });
});
