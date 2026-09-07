// @vitest-environment jsdom

/**
 * What a finished session was worth, across sessions rather than within one.
 *
 * The failure mode here is flattery. An improvement claimed against no
 * history, or a practice day claimed when none was recorded, both read as
 * encouragement and are both false — and a learner who notices once stops
 * trusting every other number on the screen. So each claim is tested for the
 * case where it must *not* appear.
 *
 * jsdom exposes `localStorage` as a bare object with no methods, so every test
 * installs a real in-memory Storage.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { SessionSummary } from "./SessionSummary.js";

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
const SLUG = "fr";

/** Seeds the two stores this reads. */
function seed(options: {
  days?: string[];
  longest?: number;
  skills?: Array<[grapheme: string, accuracies: number[]]>;
}): void {
  const data: Record<string, string> = {};

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
    data[`sonare.skills.v1.${SLUG}.${LEARNER}`] = JSON.stringify(store);
  }

  installStorage(data);
}

function show() {
  return render(
    <MemoryRouter>
      <SessionSummary slug={SLUG} learnerName={LEARNER} />
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

describe("the practice day", () => {
  it("says day one on a first day, and points at tomorrow", () => {
    // "1 days in a row" is both wrong and deflating on the day that matters
    // most for whether the learner comes back.
    seed({ days: ["2026-09-07"] });
    show();

    expect(screen.getByText(/day one/i)).toBeInTheDocument();
    expect(screen.getByText(/tomorrow/i)).toBeInTheDocument();
  });

  it("counts a run, with the week beside it", () => {
    seed({ days: ["2026-09-05", "2026-09-06", "2026-09-07"] });
    show();

    expect(screen.getByText(/3 days in a row/i)).toBeInTheDocument();
    expect(screen.getByText(/3 of the last 7/i)).toBeInTheDocument();
  });

  it("claims nothing when no day was recorded", () => {
    /**
     * A learner whose day could not be stored — private browsing, blocked
     * storage — must not be told it was. Claiming a streak that does not
     * exist is the kind of small lie that makes every other figure suspect.
     */
    installStorage();
    show();

    expect(screen.queryByText(/in a row/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/day one/i)).not.toBeInTheDocument();
  });

  it("claims nothing when the recorded day is not today", () => {
    // The session just finished, so if today is not in the list the write
    // failed and there is nothing to celebrate.
    seed({ days: ["2026-09-05", "2026-09-06"] });
    show();

    expect(screen.queryByText(/in a row/i)).not.toBeInTheDocument();
  });
});

describe("sounds that improved", () => {
  it("names them with the before and after", () => {
    seed({
      days: ["2026-09-07"],
      skills: [["ment", [20, 22, 24, 80, 82, 84, 86, 88]]],
    });
    show();

    expect(screen.getByText(/sounds you have improved/i)).toBeInTheDocument();
    expect(screen.getByText("ment")).toBeInTheDocument();
    expect(screen.getByText(/22 → 84/)).toBeInTheDocument();
  });

  it("claims no improvement on a first session", () => {
    /**
     * The flattering version of the same fabrication as "no change". There is
     * no history either side of the window yet, so any before-and-after would
     * be invented — and it would be invented in the direction that feels good,
     * which is exactly why it needs a test.
     */
    seed({ days: ["2026-09-07"], skills: [["ment", [40, 45]]] });
    show();

    expect(screen.queryByText(/sounds you have improved/i)).not.toBeInTheDocument();
    expect(screen.getByText(/over the next few days/i)).toBeInTheDocument();
  });

  it("says nothing about a sound that got worse", () => {
    // Not hidden as flattery — it is simply not an improvement, and the
    // weakest-sound line on the home screen is where a decline belongs.
    seed({ days: ["2026-09-07"], skills: [["ment", [90, 92, 94, 30, 32, 34, 36, 38]]] });
    show();

    expect(screen.queryByText(/sounds you have improved/i)).not.toBeInTheDocument();
  });

  it("puts the biggest improvement first", () => {
    seed({
      days: ["2026-09-07"],
      skills: [
        ["jour", [60, 60, 60, 70, 70, 70, 70, 70]],
        ["ment", [20, 20, 20, 85, 85, 85, 85, 85]],
      ],
    });
    show();

    const items = screen.getAllByRole("listitem");
    expect(items[0]?.textContent).toContain("ment");
  });

  it("shows at most three, so a finish is not a report card", () => {
    seed({
      days: ["2026-09-07"],
      skills: [
        ["aaa", [10, 10, 10, 90, 90, 90, 90, 90]],
        ["bbb", [11, 11, 11, 88, 88, 88, 88, 88]],
        ["ccc", [12, 12, 12, 86, 86, 86, 86, 86]],
        ["ddd", [13, 13, 13, 84, 84, 84, 84, 84]],
        ["eee", [14, 14, 14, 82, 82, 82, 82, 82]],
      ],
    });
    show();

    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("does not restrict itself to the weakest sounds", () => {
    /**
     * A sound that improved its way out of the bottom three is exactly the one
     * a learner most wants to hear about, so the improvement list is read
     * across every syllable rather than off the weakest-three list.
     */
    seed({
      days: ["2026-09-07"],
      skills: [
        ["weak", [10, 10, 10, 12, 12, 12, 12, 12]],
        ["fixed", [30, 30, 30, 95, 95, 95, 95, 95]],
      ],
    });
    show();

    expect(screen.getByText("fixed")).toBeInTheDocument();
  });
});

describe("getting back", () => {
  it("offers the way to today", () => {
    seed({ days: ["2026-09-07"] });
    show();

    expect(screen.getByRole("link", { name: /back to today/i })).toHaveAttribute("href", "/");
  });
});

describe("surviving bad stored data", () => {
  it("renders on a corrupt record rather than blanking the report", () => {
    // This sits underneath the session report, so an escaping error would
    // take the learner's results off the screen with it.
    installStorage({
      [`sonare.streak.v1.${LEARNER}`]: "{not json",
      [`sonare.skills.v1.${SLUG}.${LEARNER}`]: "[]",
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
