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
 * The third kind, added after a persona audit: it can be *unkind about a gap*.
 * A learner who left yesterday and one who left in July used to be greeted
 * identically, over a streak of zero beside a best run of nine. The tests below
 * pin the bands, pin the arithmetic that chooses them, and pin the absence of
 * the consolation mechanics that would normally be reached for here — a streak
 * freeze, a repair token, points. None of those are the fix; honest copy is.
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

/** The wall clock every test runs against. Local, matching how days are kept. */
const NOW = new Date("2026-09-07T12:00:00");

/**
 * An ISO instant whose **local** day is `n` days before today's.
 *
 * Built from local date parts rather than written out as a `Z` literal on
 * purpose. The screen measures the gap in the learner's own calendar, so a
 * hard-coded UTC timestamp would land on a different local day either side of
 * Greenwich and these band assertions would pass or fail by timezone.
 */
function daysAgo(n: number): string {
  return new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - n, 10, 0, 0).toISOString();
}

/** `YYYY-MM-DD` for `n` days ago, in the form the streak store stores. */
function dayAgo(n: number): string {
  const when = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - n);
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

/** A run of `length` consecutive days ending `endingDaysAgo` days back. */
function run(length: number, endingDaysAgo: number): string[] {
  return Array.from({ length }, (_, i) => dayAgo(endingDaysAgo + length - 1 - i));
}

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
  vi.setSystemTime(NOW);
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

  it("says nothing about a gap, having no gap to describe", () => {
    /**
     * The first-ever visit. `lastPractisedAt === null` is the only signal for
     * it: `allProgress` returns every language the app ships, including ones
     * nobody has opened, so a branch keyed on the list being empty would be
     * unreachable code dressed up as a guard.
     *
     * Greeting a first-time visitor with a duration would be inventing a past
     * for somebody who has none.
     */
    installStorage({ "sonare.learnerName": LEARNER });
    show();

    expect(screen.queryByText(/away/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/left off/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/best sounds/i)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2 }).textContent).not.toMatch(/again/i);
  });

  it("greets a first visit as a first visit, not a return", () => {
    // "Welcome back" to somebody who has never been here is a small lie, and
    // it is the first sentence they read.
    installStorage({ "sonare.learnerName": LEARNER });
    show();

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(`Welcome, ${LEARNER}`);
    expect(screen.getByRole("heading", { level: 2 }).textContent).not.toMatch(/back/i);
  });
});

describe("coming back after a gap", () => {
  /** Seeds one language last practised `n` days ago, plus optional extras. */
  function returning(n: number, extra: Parameters<typeof seed>[0] = {}) {
    seed({
      progress: [[FIRST.slug, [entry(1, false, daysAgo(n))]]],
      ...extra,
    });
    show();
  }

  it("says nothing when they were already here today", () => {
    // There is no gap, so describing one would be noise on the screen a
    // learner lands on straight after finishing an activity.
    returning(0);

    expect(screen.queryByText(/away/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/left off/i)).not.toBeInTheDocument();
  });

  it("reads as continuity after one day, not as an absence", () => {
    /**
     * The near boundary. Yesterday keeps the streak alive on purpose
     * (`currentRun`), so one day is not something to be gracious about —
     * treating it as one would invent a problem in order to forgive it.
     */
    returning(1);

    expect(screen.getByText("Back the next day").closest("p")).toHaveTextContent(
      "Back the next day — right where you left off.",
    );
    expect(screen.queryByText(/best sounds/i)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(`Welcome back, ${LEARNER}`);
  });

  it("counts a short gap in days", () => {
    returning(3);

    expect(screen.getByText("3 days away")).toBeInTheDocument();
  });

  it("calls a week a week rather than seven days", () => {
    returning(7);

    expect(screen.getByText("A week away")).toBeInTheDocument();
  });

  it("counts weeks, and floors rather than rounding up", () => {
    /**
     * Twenty-seven days is three weeks and six days. "4 weeks away" would
     * overstate the absence, which is the wrong direction to be wrong in when
     * the sentence is addressed to somebody who has just come back.
     */
    returning(27);

    expect(screen.getByText("3 weeks away")).toBeInTheDocument();
  });

  it("moves to months at a month", () => {
    returning(35);

    expect(screen.getByText("A month away")).toBeInTheDocument();
  });

  it("counts several months", () => {
    // The audit's other persona: gone since July, opening the app in September.
    returning(70);

    expect(screen.getByText("2 months away")).toBeInTheDocument();
  });

  it("names the sounds that held up instead of the streak that broke", () => {
    /**
     * The whole point. Three weeks away with a nine-day best run used to read
     * as a loss report; what is true and worth saying is that the sounds are
     * still there. Strongest first, and never the one the advice line below is
     * already calling the weakest.
     */
    returning(21, {
      days: run(9, 21),
      longest: 9,
      skills: [
        [FIRST.slug, "ment", [20, 20]],
        [FIRST.slug, "tion", [70, 70]],
        [FIRST.slug, "bon", [80, 80]],
      ],
    });

    const note = screen.getByText("3 weeks away").closest("p");
    // The whole sentence, pinned: this is the copy the audit asked for.
    expect(note).toHaveTextContent(
      "3 weeks away — your best sounds are still here: bon at 80 · tion at 70 (measured before you left)",
    );
    // The weakest is the thing being worked on, not a sound that held up.
    expect(note).not.toHaveTextContent("ment");
    // Strongest first — the reassurance leads with the best of them.
    expect(note?.textContent?.indexOf("bon")).toBeLessThan(note?.textContent?.indexOf("tion") ?? 0);
  });

  it("dates those figures instead of claiming them as current", () => {
    /**
     * They are means of samples taken before the gap. Presenting them in the
     * present tense would be claiming a measurement nobody has taken since,
     * which is the same dishonesty as rendering a null trend as "no change".
     */
    returning(21, {
      skills: [
        [FIRST.slug, "ment", [20, 20]],
        [FIRST.slug, "bon", [80, 80]],
      ],
    });

    expect(screen.getByText(/measured before you left/i)).toBeInTheDocument();
    expect(screen.queryByText(/now at 80/i)).not.toBeInTheDocument();
  });

  it("will not call one sound both the weakest and the best", () => {
    // With a single measured sound the advice line already names it. Offering
    // the same syllable back as what held up says nothing and reads as a bug.
    returning(21, { skills: [[FIRST.slug, "ment", [40, 45]]] });

    expect(screen.getByText(/working on/i)).toBeInTheDocument();
    expect(screen.queryByText(/best sounds are still here/i)).not.toBeInTheDocument();
    expect(screen.getByText("3 weeks away").closest("p")).toHaveTextContent(
      "nothing you built has gone anywhere",
    );
  });

  it("stays general when no sound has enough history to vouch for", () => {
    // A single take is not a strength, and naming one as the thing that
    // survived three weeks would be inventing an achievement.
    returning(21, { skills: [[FIRST.slug, "ment", [40]]] });

    expect(screen.queryByText(/best sounds are still here/i)).not.toBeInTheDocument();
    expect(screen.getByText("3 weeks away").closest("p")).toHaveTextContent(
      "Your record is still here",
    );
  });

  it("greets a long absence differently from a day away", () => {
    returning(21);

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      `Good to see you again, ${LEARNER}`,
    );
  });

  it("greets an unnamed learner without a hole where the name goes", () => {
    // "Good to see you again, null" is the same class of bug as "Welcome, null".
    installStorage({
      [`sonare.progress.v2.${FIRST.slug}.anonymous`]: JSON.stringify({
        index: 0,
        progress: [entry(1, false, daysAgo(21))],
        finished: false,
      }),
    });
    show();

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Good to see you again");
    expect(screen.getByRole("heading", { level: 2 }).textContent).not.toMatch(/null|undefined/);
  });

  it("offers to pick it back up rather than to carry on", () => {
    // "Carry on" is what somebody mid-flow is doing. It was the line the audit
    // pointed at: identical for a learner who left yesterday and one who left
    // in July.
    returning(21);

    expect(screen.getByRole("link", { name: /pick up again/i })).toHaveAttribute(
      "href",
      `/${FIRST.slug}`,
    );
    expect(screen.queryByRole("link", { name: /carry on/i })).not.toBeInTheDocument();
  });

  it("still offers to practise again when the language is finished", () => {
    // A completed set has nothing to pick back up, and "Pick up again" over a
    // language with no unpassed activity left would be pointing at nothing.
    seed({
      progress: [[FIRST.slug, FIRST.activities.map((a) => entry(a.id, true, daysAgo(21)))]],
    });
    show();

    expect(screen.getByRole("link", { name: /practise again/i })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /pick up again/i })).not.toBeInTheDocument();
  });

  it("measures the gap from the last language practised, not the one resumed", () => {
    /**
     * The arithmetic trap. `nextUp` prefers an *unfinished* language, so a
     * learner who finished French yesterday and left the next language
     * half-done three weeks ago is offered that one — and reading the gap off
     * the resumed language would greet somebody who was here yesterday with
     * "3 weeks away".
     */
    seed({
      progress: [
        [FIRST.slug, FIRST.activities.map((a) => entry(a.id, true, daysAgo(1)))],
        [SECOND.slug, [entry(1, false, daysAgo(21))]],
      ],
    });
    show();

    // The resumed language is the unfinished one...
    expect(screen.getByRole("link", { name: /carry on/i })).toHaveAttribute(
      "href",
      `/${SECOND.slug}`,
    );
    // ...but the gap is a fact about the learner, not about that language.
    expect(screen.getByText("Back the next day")).toBeInTheDocument();
    expect(screen.queryByText(/weeks away/i)).not.toBeInTheDocument();
  });

  it("survives a last-practised timestamp that is not a date", () => {
    // Stored data outlives the code that wrote it. "NaN days away" on the
    // screen a learner lands on is worse than saying nothing.
    installStorage({
      "sonare.learnerName": LEARNER,
      [`sonare.progress.v2.${FIRST.slug}.${LEARNER}`]: JSON.stringify({
        index: 0,
        progress: [
          {
            activityId: 1,
            attempts: [{ activityId: 1, result: {}, accuracy: 20, at: "not a date" }],
            best: 20,
            passed: false,
            skipped: false,
          },
        ],
        finished: false,
      }),
    });

    expect(() => show()).not.toThrow();
    expect(screen.queryByText(/NaN|Invalid/i)).not.toBeInTheDocument();
  });
});

describe("a broken streak beside a real best run", () => {
  /** Three weeks away, with nine consecutive days behind them. */
  function lapsed() {
    seed({
      progress: [[FIRST.slug, [entry(1, false, daysAgo(21))]]],
      days: run(9, 21),
      longest: 9,
      skills: [
        [FIRST.slug, "ment", [20, 20]],
        [FIRST.slug, "bon", [80, 80]],
      ],
    });
    show();
  }

  it("does not leave a bare zero sitting next to the record", () => {
    // 0 beside 9 with no sentence between them is a loss report. The same fact
    // stated forwards is not.
    lapsed();

    const tile = screen.getByText("Streak").closest("div");
    expect(tile).toHaveTextContent("0");
    expect(tile).toHaveTextContent(/ready to start again/i);
    expect(screen.getByText("Best run").closest("div")).toHaveTextContent("9");
  });

  it("credits nothing back: the streak is still zero and the week still empty", () => {
    /**
     * The line this feature must not cross. A streak freeze, a repair token or
     * a make-up day would all put a number back that the learner did not earn
     * by showing up — and the streak's whole defence is that it counts
     * attendance and takes no score. Kinder words, identical arithmetic.
     */
    lapsed();

    expect(screen.getByText("Streak").closest("div")).toHaveTextContent("0");
    expect(screen.getByText("This week").closest("div")).toHaveTextContent("0");
    expect(screen.queryByText(/freeze|frozen|repair|restore|streak saver|make.?up/i)).toBeNull();
  });

  it("attaches no points, XP, hearts or league to the return", () => {
    // Every one of those is a number about performance, and whether this
    // scorer is fair across accents is still unmeasured (T19).
    lapsed();

    expect(screen.queryByText(/\bXP\b|\bpoints?\b|\bhearts?\b|\bleague\b|\bgems?\b/i)).toBeNull();
  });

  it("says practised today instead, once the day is credited", () => {
    // The lapse copy is for a zero. It must not linger over a 1.
    seed({
      progress: [[FIRST.slug, [entry(1, false, daysAgo(0))]]],
      days: [dayAgo(0)],
      longest: 9,
    });
    show();

    const tile = screen.getByText("Streak").closest("div");
    expect(tile).toHaveTextContent(/practised today/i);
    expect(tile).not.toHaveTextContent(/ready to start again/i);
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
