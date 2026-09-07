// @vitest-environment jsdom

/**
 * The front door.
 *
 * Two kinds of failure matter here. The screen can be *wrong about the
 * learner* — offering a language they were not doing, or an activity they have
 * already passed — which makes the one tap it exists for the wrong tap. And it
 * can be *dishonest*, which is worse: reporting "no change" on a first week
 * invents a comparison against history that does not exist, and a streak tied
 * to performance would punish the accent a learner arrived with.
 *
 * jsdom exposes `localStorage` as a bare object with no methods, so every test
 * installs a real in-memory Storage. Without that they would all pass
 * vacuously.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { Today } from "./Today.js";
import { LANGUAGES } from "../activities/languages/index.js";
import type { ActivityProgress } from "../activities/types.js";

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

const LEARNER = "marie";

function set(index: number) {
  const found = LANGUAGES[index];
  if (found === undefined) throw new Error(`no language at ${index}`);
  return found;
}

const FIRST = set(0);
const SECOND = set(1);

function entry(activityId: number, passed: boolean, at: string): ActivityProgress {
  return {
    activityId,
    attempts: [{ activityId, result: {} as never, accuracy: passed ? 80 : 20, at }],
    best: passed ? 80 : 20,
    passed,
    skipped: false,
  };
}

/** Seeds the stores this screen reads, under the keys they really use. */
function seed(options: {
  progress?: Array<[slug: string, entries: ActivityProgress[]]>;
  days?: string[];
  longest?: number;
  skills?: Array<[slug: string, grapheme: string, accuracies: number[]]>;
}): void {
  const data: Record<string, string> = { "sonare.learnerName": LEARNER };

  for (const [slug, entries] of options.progress ?? []) {
    data[`sonare.progress.v2.${slug}.${LEARNER}`] = JSON.stringify({
      index: 0,
      progress: entries,
      finished: false,
    });
  }
  if (options.days !== undefined) {
    data[`sonare.streak.v1.${LEARNER}`] = JSON.stringify({
      days: options.days,
      current: 0,
      longest: options.longest ?? 0,
    });
  }
  for (const [slug, grapheme, accuracies] of options.skills ?? []) {
    const key = `sonare.skills.v1.${slug}.${LEARNER}`;
    const existing = key in data ? (JSON.parse(data[key] as string) as Record<string, unknown>) : {};
    existing[grapheme] = {
      grapheme,
      samples: accuracies.map((accuracy, i) => ({
        at: `2026-09-0${(i % 9) + 1}T10:00:00.000Z`,
        accuracy,
      })),
    };
    data[key] = JSON.stringify(existing);
  }

  installStorage(data);
}

function show() {
  return render(
    <MemoryRouter>
      <Today />
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

describe("a learner who has never practised", () => {
  it("is sent to the picker, not shown an empty dashboard", () => {
    /**
     * Four zeroes and a streak of nothing is a worse first impression than a
     * question, and there is nothing to resume.
     */
    installStorage({ "sonare.learnerName": LEARNER });
    show();

    expect(screen.getByRole("link", { name: /choose a language/i })).toHaveAttribute("href", "/languages");
    expect(screen.queryByText(/streak/i)).not.toBeInTheDocument();
  });

  it("greets them by name when it knows one", () => {
    installStorage({ "sonare.learnerName": LEARNER });
    show();

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(`Welcome, ${LEARNER}`);
  });

  it("does not use a name it does not have", () => {
    // "Welcome, null" has shipped in real products.
    installStorage();
    show();

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Welcome");
    expect(screen.getByRole("heading", { level: 2 }).textContent).not.toMatch(/null|undefined/);
  });
});

describe("the tap the learner came to make", () => {
  it("offers the language they were last doing", () => {
    seed({
      progress: [
        [FIRST.slug, [entry(1, true, "2026-09-01T10:00:00.000Z")]],
        [SECOND.slug, [entry(1, true, "2026-09-06T10:00:00.000Z")]],
      ],
    });
    show();

    const resume = screen.getByRole("link", { name: /carry on/i });
    expect(resume).toHaveAttribute("href", `/${SECOND.slug}`);
    expect(resume).toHaveTextContent(SECOND.label);
  });

  it("offers the activity they have not done, not the one they stopped at", () => {
    /**
     * A learner who exhausted three tries on the second activity and moved on
     * has an unpassed second activity. Offering the third would skip the thing
     * they have not done.
     */
    const second = FIRST.activities[1];
    if (second === undefined) throw new Error("need two activities");
    seed({
      progress: [
        [
          FIRST.slug,
          [
            entry(FIRST.activities[0]?.id ?? 1, true, "2026-09-07T10:00:00.000Z"),
            { ...entry(second.id, false, "2026-09-07T10:05:00.000Z"), skipped: true },
          ],
        ],
      ],
    });
    show();

    expect(screen.getByRole("link", { name: /carry on/i })).toHaveTextContent("2 of");
  });

  it("offers to practise again once a language is finished", () => {
    // "Carry on" implies something unfinished.
    seed({
      progress: [
        [FIRST.slug, FIRST.activities.map((a) => entry(a.id, true, "2026-09-07T10:00:00.000Z"))],
      ],
    });
    show();

    expect(screen.getByRole("link", { name: /practise again/i })).toBeInTheDocument();
  });

  it("tags the target-language phrase with its own language", () => {
    // WCAG 3.1.2 — a screen reader needs the tag to pronounce a French
    // activity title in French rather than in the page's language.
    seed({ progress: [[FIRST.slug, [entry(1, false, "2026-09-07T10:00:00.000Z")]]] });
    const { container } = show();

    const tagged = container.querySelector(`[lang="${FIRST.code}"]`);
    expect(tagged).not.toBeNull();
  });
});

describe("the streak counts showing up", () => {
  it("shows a run of consecutive days", () => {
    seed({
      progress: [[FIRST.slug, [entry(1, false, "2026-09-07T10:00:00.000Z")]]],
      days: ["2026-09-05", "2026-09-06", "2026-09-07"],
    });
    show();

    expect(screen.getByText("Streak").closest("div")).toHaveTextContent("3");
  });

  it("shows days in the last week beside it", () => {
    /**
     * The kinder and often truer figure. Four of seven is a good week, and a
     * learner who missed Wednesday has not failed — a raw streak alone turns
     * one busy day into a reason to stop.
     */
    seed({
      progress: [[FIRST.slug, [entry(1, false, "2026-09-07T10:00:00.000Z")]]],
      days: ["2026-09-01", "2026-09-03", "2026-09-05", "2026-09-06", "2026-09-07"],
    });
    show();

    // Five of the last seven, while the streak itself is only three.
    expect(screen.getByText("This week").closest("div")).toHaveTextContent("5");
    expect(screen.getByText("Streak").closest("div")).toHaveTextContent("3");
  });

  it("keeps the best run visible through a lapse", () => {
    // Losing the achievement along with the streak makes a missed day cost
    // twice, which is the shape that stops people coming back.
    seed({
      progress: [[FIRST.slug, [entry(1, false, "2026-09-07T10:00:00.000Z")]]],
      days: ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"],
      longest: 4,
    });
    show();

    expect(screen.getByText("Streak").closest("div")).toHaveTextContent("0");
    expect(screen.getByText("Best run").closest("div")).toHaveTextContent("4");
  });

  it("says so when today is already done", () => {
    seed({
      progress: [[FIRST.slug, [entry(1, false, "2026-09-07T10:00:00.000Z")]]],
      days: ["2026-09-07"],
    });
    show();

    expect(screen.getByText(/practised today/i)).toBeInTheDocument();
  });

  it("uses the singular for one day", () => {
    seed({
      progress: [[FIRST.slug, [entry(1, false, "2026-09-07T10:00:00.000Z")]]],
      days: ["2026-09-07"],
    });
    show();

    expect(screen.getByText("Streak").closest("div")).toHaveTextContent(/1\s*day\b/);
  });
});

describe("the sound being worked on", () => {
  it("names it and gives the figure", () => {
    seed({
      progress: [[FIRST.slug, [entry(1, false, "2026-09-07T10:00:00.000Z")]]],
      skills: [[FIRST.slug, "ment", [40, 50, 60, 70, 80, 61, 62, 63]]],
    });
    show();

    expect(screen.getByText(/working on/i)).toBeInTheDocument();
    expect(screen.getByText("ment")).toBeInTheDocument();
  });

  it("says there is not enough history rather than no change", () => {
    /**
     * The honesty case. `trendFor` returns a null `before` until there is
     * history either side of the window, and rendering that as "no change"
     * invents a comparison — a learner reading it on their first Tuesday has
     * been told something false.
     */
    seed({
      progress: [[FIRST.slug, [entry(1, false, "2026-09-07T10:00:00.000Z")]]],
      skills: [[FIRST.slug, "ment", [40, 45]]],
    });
    show();

    expect(screen.getByText(/not enough history/i)).toBeInTheDocument();
    expect(screen.queryByText(/no change/i)).not.toBeInTheDocument();
  });

  it("reports an improvement as up, and against the earlier figure", () => {
    seed({
      progress: [[FIRST.slug, [entry(1, false, "2026-09-07T10:00:00.000Z")]]],
      skills: [[FIRST.slug, "ment", [20, 20, 20, 80, 80, 80, 80, 80]]],
    });
    show();

    expect(screen.getByText(/up from 20/i)).toBeInTheDocument();
  });

  it("reports a regression as down", () => {
    seed({
      progress: [[FIRST.slug, [entry(1, false, "2026-09-07T10:00:00.000Z")]]],
      skills: [[FIRST.slug, "ment", [90, 90, 90, 30, 30, 30, 30, 30]]],
    });
    show();

    expect(screen.getByText(/down from 90/i)).toBeInTheDocument();
  });

  it("shows nothing at all when no sound has enough samples", () => {
    // Rather than a heading over an empty space, or a sound the learner
    // fluffed once presented as their weakness.
    seed({
      progress: [[FIRST.slug, [entry(1, false, "2026-09-07T10:00:00.000Z")]]],
      skills: [[FIRST.slug, "ment", [40]]],
    });
    show();

    expect(screen.queryByText(/working on/i)).not.toBeInTheDocument();
  });
});

describe("the other languages", () => {
  it("lists them without repeating the one being resumed", () => {
    seed({ progress: [[FIRST.slug, [entry(1, false, "2026-09-07T10:00:00.000Z")]]] });
    show();

    expect(screen.getByRole("heading", { name: /other languages/i })).toBeInTheDocument();
    // The resume card is the only link to the current language.
    expect(screen.getAllByRole("link", { name: new RegExp(FIRST.label) })).toHaveLength(1);
    expect(screen.getByRole("link", { name: new RegExp(SECOND.label) })).toHaveAttribute(
      "href",
      `/${SECOND.slug}`,
    );
  });

  it("shows a count of activities for one never started", () => {
    seed({ progress: [[FIRST.slug, [entry(1, false, "2026-09-07T10:00:00.000Z")]]] });
    show();

    expect(screen.getByRole("link", { name: new RegExp(SECOND.label) })).toHaveTextContent(
      `${SECOND.activities.length} activities`,
    );
  });

  it("shows how far through a started one is", () => {
    seed({
      progress: [
        [FIRST.slug, [entry(1, false, "2026-09-07T10:00:00.000Z")]],
        [
          SECOND.slug,
          [
            entry(SECOND.activities[0]?.id ?? 1, true, "2026-09-01T10:00:00.000Z"),
            entry(SECOND.activities[1]?.id ?? 2, true, "2026-09-01T10:01:00.000Z"),
          ],
        ],
      ],
    });
    show();

    expect(screen.getByRole("link", { name: new RegExp(SECOND.label) })).toHaveTextContent(
      `2 of ${SECOND.activities.length} passed`,
    );
  });
});

describe("surviving bad stored data", () => {
  it("renders rather than blanking on a corrupt record", () => {
    // This is where a learner lands, so an escaping error is a blank page
    // before they have done anything.
    installStorage({
      "sonare.learnerName": LEARNER,
      [`sonare.progress.v2.${FIRST.slug}.${LEARNER}`]: "{not json",
      [`sonare.streak.v1.${LEARNER}`]: "also not json",
      [`sonare.skills.v1.${FIRST.slug}.${LEARNER}`]: "[]",
    });

    expect(() => show()).not.toThrow();
    expect(screen.getByRole("heading", { level: 2 })).toBeInTheDocument();
  });

  it("renders when storage refuses entirely", () => {
    installStorage({ "sonare.learnerName": LEARNER });
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });

    expect(() => show()).not.toThrow();
  });
});
